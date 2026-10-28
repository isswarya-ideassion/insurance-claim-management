import { ACTIVE_STATUSES, ROLES, humanize } from '../../../../shared/constants.js'
import { businessRule, conflict, notFound } from '../../utils/errors.js'
import { hoursFromNow } from '../../utils/format.js'
import {
  claimScope,
  loadAccessibleClaim,
  requirePermission,
  requireNotOwnClaim,
  requireTab,
} from '../../services/access.service.js'
import { lockClaim } from '../../services/workflow.service.js'
import { requiredArtifacts } from '../../services/config.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { logger } from '../../config/logger.js'

const CUSTOMER_REQUEST_DAYS = 7

// ---------------------------------------------------------------------------
// Missing-document detection (rule-based: required checklist per claim type)
// ---------------------------------------------------------------------------

/**
 * Compares the claim's documents and open requests with its required artifacts
 * (artifact_requirements; the segment configuration for drafts). Pure data; no AI is involved.
 */
export async function computeDocumentChecklist(t, claim, now = new Date()) {
  const [docs, requirements] = await Promise.all([
    t.findMany('documents', { where: { claim_id: claim.id }, orderBy: [['received_at', 'desc']] }),
    t.findMany('artifact_requirements', { where: { claim_id: claim.id, requirement_type: 'DOCUMENT' } }),
  ])
  const requiredRows = requirements.filter((r) => r.is_required)
  const required = requiredRows.length ? requiredRows.map((r) => r.doc_type) : await requiredArtifacts(t, claim.segment, claim.claim_type)
  const openRequests = requirements.filter((r) => r.status === 'REQUESTED')

  const items = required.map((docType) => {
    const current = docs.filter((d) => d.doc_type === docType)
    const accepted = current.filter((d) => d.status === 'ACCEPTED')
    const pending = current.filter((d) => d.status === 'PENDING_REVIEW')
    const rejected = current.filter((d) => d.status === 'REJECTED')
    const row = requiredRows.find((r) => r.doc_type === docType)
    const request = openRequests.find((r) => r.doc_type === docType)
    const state = row?.status === 'WAIVED' ? 'WAIVED'
      : accepted.length ? 'ACCEPTED' : pending.length ? 'PENDING_REVIEW' : rejected.length ? 'REJECTED' : 'MISSING'
    return {
      category: docType,
      label: humanize(docType),
      state,
      requirementId: row?.id || null,
      documents: current.map((d) => ({ id: d.id, file_name: d.file_name, status: d.status, received_at: d.received_at })),
      rejectionReason: state === 'REJECTED' ? rejected[0].rejection_reason : null,
      openRequest: request
        ? { id: request.id, due_at: request.due_at, overdue: Boolean(request.due_at && new Date(request.due_at) < now) }
        : null,
    }
  })

  const additional = docs
    .filter((d) => !required.includes(d.doc_type))
    .map((d) => ({ id: d.id, category: d.doc_type, label: humanize(d.doc_type), status: d.status, received_at: d.received_at }))

  const exception = Boolean(claim.document_exception_at)
  const outstanding = exception ? [] : items.filter((i) => i.state === 'MISSING' || i.state === 'REJECTED')
  const needsRequest = outstanding.filter((i) => !i.openRequest)
  const overdueRequests = outstanding.filter((i) => i.openRequest?.overdue)
  const awaiting = outstanding.filter((i) => i.openRequest && !i.openRequest.overdue)
  const pending = items.filter((i) => i.state === 'PENDING_REVIEW')
  const list = (arr) => arr.map((i) => i.label).join(', ')

  const actions = []
  if (!ACTIVE_STATUSES.includes(claim.status)) {
    actions.push({ code: 'NONE', message: `The claim is ${humanize(claim.status).toLowerCase()}; no document action is needed.` })
  } else if (exception) {
    actions.push({ code: 'NONE', message: 'A manager recorded a document exception, so no further documents are required.' })
  } else {
    if (needsRequest.length) {
      actions.push({ code: 'REQUEST_DOCUMENTS', message: `Ask the claimant for: ${list(needsRequest)}. A reminder draft can be prepared for your approval.` })
    }
    if (overdueRequests.length) {
      actions.push({ code: 'FOLLOW_UP', message: `The request for ${list(overdueRequests)} is past its due date. Follow up with the claimant.` })
    }
    if (awaiting.length) {
      actions.push({ code: 'WAIT', message: `Waiting for the claimant to send: ${list(awaiting)}.` })
    }
    if (pending.length) {
      actions.push({ code: 'REVIEW_PENDING', message: `${pending.length} required document${pending.length === 1 ? ' is' : 's are'} awaiting review by Document Review.` })
    }
    if (outstanding.length === 0 && pending.length === 0) {
      actions.push(
        claim.status === 'DOCUMENT_REVIEW'
          ? { code: 'ADVANCE', message: 'All required documents are accepted. The claim can move to adjuster assignment.' }
          : { code: 'COMPLETE', message: 'All required documents are accepted.' },
      )
    }
  }

  return {
    claimType: claim.claim_type,
    required: items,
    additional,
    documentException: exception ? { reason: claim.document_exception_reason, at: claim.document_exception_at } : null,
    outstanding: outstanding.map((i) => i.category),
    requestable: needsRequest.map((i) => i.category),
    complete: outstanding.length === 0 && pending.length === 0,
    suggestedActions: actions,
  }
}

function draftMessage(claim, items) {
  const lines = items.map((i) =>
    i.state === 'REJECTED' && i.rejectionReason
      ? `• ${i.label} — the previous file could not be accepted: ${i.rejectionReason}`
      : `• ${i.label}`,
  )
  return [
    `Hello,`,
    ``,
    `To continue processing claim ${claim.claim_number}, we still need the following document${items.length === 1 ? '' : 's'}:`,
    ...lines,
    ``,
    `Please upload ${items.length === 1 ? 'it' : 'them'} from your claim page within ${CUSTOMER_REQUEST_DAYS} days. If you have questions, reply through the claim page and our claims team will help.`,
    ``,
    `HarborPoint Claims`,
  ].join('\n')
}

async function loadAutomationClaim(t, ctx, claimId) {
  const claim = await loadAccessibleClaim(t, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'automation')
  return claim
}

export async function getDocumentChecklist(ctx, claimId) {
  requirePermission(ctx.actor, 'automation.documentChecklist')
  const claim = await loadAutomationClaim(ctx.db, ctx, claimId)
  const checklist = await computeDocumentChecklist(ctx.db, claim)
  const openDraft = await ctx.db.findOne('claim_reminders', { claim_id: claimId, status: 'DRAFT' })
  return { ...checklist, openDraft }
}

// ---------------------------------------------------------------------------
// Customer reminder drafts (need a person's approval before anything is sent)
// ---------------------------------------------------------------------------

export async function createReminderDraft(ctx, claimId, { categories } = {}) {
  requirePermission(ctx.actor, 'automation.reminders')
  return ctx.db.tx(async (t) => {
    const claim = await loadAutomationClaim(t, ctx, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status)) throw businessRule('INVALID_STAGE', 'Reminders can only be prepared for open claims')
    if (await t.findOne('claim_reminders', { claim_id: claimId, status: 'DRAFT' })) {
      throw conflict('A reminder draft for this claim is already awaiting approval', 'DRAFT_EXISTS')
    }
    const checklist = await computeDocumentChecklist(t, claim)
    const wanted = categories?.length ? checklist.requestable.filter((c) => categories.includes(c)) : checklist.requestable
    if (wanted.length === 0) {
      throw businessRule('NOTHING_TO_REQUEST', 'No missing documents need a new request (they are received, already requested, or covered by an exception).')
    }
    const items = checklist.required.filter((i) => wanted.includes(i.category))
    const reminder = await t.insert('claim_reminders', {
      claim_id: claimId,
      reminder_type: 'MISSING_DOCUMENTS',
      audience: 'CUSTOMER',
      recipient_id: claim.customer_id,
      status: 'DRAFT',
      due_at: hoursFromNow(CUSTOMER_REQUEST_DAYS * 24),
      title: `Documents needed for claim ${claim.claim_number}`,
      message: draftMessage(claim, items),
      doc_types: wanted,
      created_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: 'REMINDER_DRAFT_CREATED',
      entityType: 'claim_reminder',
      entityId: reminder.id,
      claimId,
      metadata: { categories: wanted },
    })
    return reminder
  })
}

async function loadDraft(t, ctx, reminderId) {
  const reminder = await t.findOne('claim_reminders', { id: reminderId }, { forUpdate: true })
  if (!reminder) throw notFound('Reminder not found')
  const claim = await loadAutomationClaim(t, ctx, reminder.claim_id)
  if (reminder.status !== 'DRAFT') throw conflict(`This reminder is already ${reminder.status.toLowerCase()}`, 'REMINDER_NOT_DRAFT')
  return { reminder, claim }
}

/**
 * A person approves a customer draft: the message (optionally edited) marks one
 * artifact requirement per document type as requested, and a single
 * notification goes to the claimant.
 */
export async function approveReminder(ctx, reminderId, { message } = {}) {
  requirePermission(ctx.actor, 'automation.reminders')
  return ctx.db.tx(async (t) => {
    const { reminder } = await loadDraft(t, ctx, reminderId)
    const claim = await lockClaim(t, reminder.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status)) throw businessRule('INVALID_STAGE', 'The claim is no longer open; discard this draft instead')

    const finalMessage = message?.trim() || reminder.message
    const checklist = await computeDocumentChecklist(t, claim)
    const categories = reminder.doc_types.filter((c) => checklist.requestable.includes(c))
    if (categories.length === 0) {
      throw businessRule('NOTHING_TO_REQUEST', 'These documents were received or requested since the draft was prepared. Discard the draft.')
    }
    const due = hoursFromNow(CUSTOMER_REQUEST_DAYS * 24)
    const requests = []
    const request = { status: 'REQUESTED', request_message: finalMessage, due_at: due, requested_by: ctx.actor.id, requested_at: new Date() }
    for (const docType of categories) {
      const required = await t.findOne('artifact_requirements', { claim_id: claim.id, doc_type: docType, is_required: true }, { forUpdate: true })
      requests.push(
        required
          ? await t.updateById('artifact_requirements', required.id, request)
          : await t.insert('artifact_requirements', { claim_id: claim.id, requirement_type: 'DOCUMENT', doc_type: docType, ...request }),
      )
    }
    const [notification] = await notify(ctx, t, {
      recipientIds: [claim.customer_id],
      claimId: claim.id,
      type: 'DOCUMENTS_REQUIRED',
      title: reminder.title,
      message: finalMessage,
      link: claimLink(claim, true),
    })
    const updated = await t.updateById('claim_reminders', reminder.id, {
      status: 'APPROVED',
      message: finalMessage,
      doc_types: categories,
      artifact_requirement_ids: requests.map((r) => r.id),
      notification_id: notification?.id || null,
      decided_by: ctx.actor.id,
      decided_at: new Date(),
    })
    await recordAudit(t, ctx.actor, {
      action: 'REMINDER_APPROVED',
      entityType: 'claim_reminder',
      entityId: reminder.id,
      claimId: claim.id,
      metadata: { docTypes: categories, edited: finalMessage !== reminder.message, artifactRequirementIds: requests.map((r) => r.id) },
    })
    return updated
  })
}

export async function discardReminder(ctx, reminderId) {
  requirePermission(ctx.actor, 'automation.reminders')
  return ctx.db.tx(async (t) => {
    const { reminder } = await loadDraft(t, ctx, reminderId)
    const updated = await t.updateById('claim_reminders', reminder.id, { status: 'DISCARDED', decided_by: ctx.actor.id, decided_at: new Date() })
    await recordAudit(t, ctx.actor, { action: 'REMINDER_DISCARDED', entityType: 'claim_reminder', entityId: reminder.id, claimId: reminder.claim_id })
    return updated
  })
}

async function presentReminders(t, rows) {
  const claims = rows.length ? await t.findMany('claims', { where: { id: { in: [...new Set(rows.map((r) => r.claim_id))] } }, columns: ['id', 'claim_number', 'status'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const names = await profileMap(t, rows.flatMap((r) => [r.recipient_id, r.created_by, r.decided_by]))
  return rows.map((r) => ({
    ...r,
    claim_number: claimMap[r.claim_id]?.claim_number,
    claim_status: claimMap[r.claim_id]?.status,
    recipient_name: nameOf(names, r.recipient_id),
    created_by_name: r.created_by ? nameOf(names, r.created_by) : 'Automatic',
    decided_by_name: nameOf(names, r.decided_by),
  }))
}

export async function listClaimReminders(ctx, claimId) {
  requirePermission(ctx.actor, 'automation.view')
  await loadAutomationClaim(ctx.db, ctx, claimId)
  const rows = await ctx.db.findMany('claim_reminders', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']], limit: 100 })
  return presentReminders(ctx.db, rows)
}

export async function listReminders(ctx, query) {
  requirePermission(ctx.actor, 'automation.view')
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) return { items: [], meta: { page: 1, pageSize: query.pageSize, total: 0, totalPages: 1 } }
  const claimIds = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
  const where = { claim_id: { in: claimIds } }
  if (query.status) where.status = query.status
  if (query.audience) where.audience = query.audience
  if (query.type) where.reminder_type = query.type
  const [rows, total] = await Promise.all([
    ctx.db.findMany('claim_reminders', { where, orderBy: [['created_at', 'desc']], limit: query.pageSize, offset: (query.page - 1) * query.pageSize }),
    ctx.db.count('claim_reminders', where),
  ])
  return {
    items: await presentReminders(ctx.db, rows),
    meta: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
  }
}

// ---------------------------------------------------------------------------
// Deadline sweep (scheduled with the overdue-task sweep, or run on demand)
// ---------------------------------------------------------------------------

/**
 * Notifies the responsible Claims Manager (assigned owner) or, when nobody owns
 * the claim, all Claims Managers about claims approaching or past their SLA due
 * date. A dedupe key per claim, type, due date and recipient guarantees each
 * reminder is sent once. Also prepares (never sends) customer drafts for claims
 * waiting on documents that nobody has requested yet.
 */
export async function runDeadlineReminderSweep(deps, { now = new Date() } = {}) {
  const ctx = { ...deps, actor: { id: null, roles: ['SYSTEM'], requestId: 'reminder-sweep' } }
  const horizon = new Date(now.getTime() + deps.config.REMINDER_LEAD_HOURS * 3600_000)
  const claims = await deps.db.query(
    `select * from public.claims where status = any($1::text[]) and due_date is not null and due_date <= $2 order by due_date`,
    [ACTIVE_STATUSES, horizon],
  )
  const managers = await userIdsWithRole(deps.db, ROLES.OPS_MANAGER)
  let sent = 0
  for (const claim of claims) {
    const overdue = new Date(claim.due_date) < now
    const type = overdue ? 'DEADLINE_OVERDUE' : 'DEADLINE_APPROACHING'
    const recipients = claim.assigned_owner_id ? [claim.assigned_owner_id] : managers
    const due = new Date(claim.due_date)
    const title = overdue ? `Claim ${claim.claim_number} is past its deadline` : `Claim ${claim.claim_number} is due soon`
    const message = `${humanize(claim.status)} stage ${overdue ? 'was' : 'is'} due ${due.toUTCString()}.${claim.assigned_owner_id ? '' : ' The claim has no assigned owner.'}`
    for (const recipientId of recipients) {
      await deps.db.tx(async (t) => {
        const [inserted] = await t.query(
          `insert into public.claim_reminders (claim_id, reminder_type, audience, recipient_id, status, due_at, title, message, dedupe_key)
           values ($1, $2, 'INTERNAL', $3, 'SENT', $4, $5, $6, $7)
           on conflict (dedupe_key) do nothing returning id`,
          [claim.id, type, recipientId, due, title, message, `${claim.id}:${type}:${due.toISOString()}:${recipientId}`],
        )
        if (!inserted) return
        const [notification] = await notify(ctx, t, {
          recipientIds: [recipientId],
          claimId: claim.id,
          type: 'DEADLINE_REMINDER',
          title,
          message,
          link: `/claims/${claim.id}?tab=automation`,
        })
        if (notification) await t.updateById('claim_reminders', inserted.id, { notification_id: notification.id })
        sent += 1
      })
    }
  }

  // Prepare customer drafts for claims waiting on documents nobody has requested.
  let drafts = 0
  const waiting = await deps.db.findMany('claims', { where: { status: 'DOCUMENTS_REQUIRED' } })
  for (const claim of waiting) {
    const checklist = await computeDocumentChecklist(deps.db, claim, now)
    if (checklist.requestable.length === 0) continue
    const items = checklist.required.filter((i) => checklist.requestable.includes(i.category))
    const [inserted] = await deps.db.query(
      `insert into public.claim_reminders (claim_id, reminder_type, audience, recipient_id, status, due_at, title, message, doc_types)
       values ($1, 'MISSING_DOCUMENTS', 'CUSTOMER', $2, 'DRAFT', $3, $4, $5, $6)
       on conflict (claim_id) where status = 'DRAFT' do nothing returning id`,
      [claim.id, claim.customer_id, hoursFromNow(CUSTOMER_REQUEST_DAYS * 24, now), `Documents needed for claim ${claim.claim_number}`, draftMessage(claim, items), checklist.requestable],
    )
    if (inserted) drafts += 1
  }

  if (sent || drafts) logger.info('reminder sweep complete', { claimsChecked: claims.length, remindersSent: sent, draftsPrepared: drafts })
  return { claimsChecked: claims.length, remindersSent: sent, draftsPrepared: drafts }
}

export async function triggerReminderSweep(ctx) {
  requirePermission(ctx.actor, 'automation.reminders')
  const result = await runDeadlineReminderSweep(ctx)
  await recordAudit(ctx.db, ctx.actor, { action: 'REMINDER_SWEEP_RUN', entityType: 'job', metadata: result })
  return result
}
