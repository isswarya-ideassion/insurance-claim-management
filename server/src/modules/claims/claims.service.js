import {
  ROLES,
  ACTIVE_STATUSES,
  INTAKE_CHECKLIST,
  REQUIRED_DOCUMENTS,
  OPEN_TASK_STATUSES,
  STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  humanize,
} from '../../../../shared/constants.js'
import { can, visibleTabs, permissionsFor } from '../../../../shared/permissions.js'
import { businessRule, conflict, forbidden, notFound, validationError } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import {
  claimScope,
  loadAccessibleClaim,
  isCustomerView,
  isStaff,
  requirePermission,
  requireNotOwnClaim,
  requireStaffView,
} from '../../services/access.service.js'
import { availableTransitions, lockClaim, missingRequiredDocuments, transitionClaim, hasActiveComplianceHold } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { checkClaimEligibility, evaluatePolicyEligibility } from '../../services/eligibility.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { presentClaimForCustomer, presentClaimForStaff, presentClaims, profileMap, nameOf } from '../../services/presenters.js'
import { presentPolicy } from '../policies/policies.service.js'
import { submissionReadySchema } from './claims.validators.js'

const DRAFT_FIELD_MAP = {
  claimType: 'claim_type',
  insuredName: 'insured_name',
  incidentAt: 'incident_at',
  incidentLocation: 'incident_location',
  incidentCategory: 'incident_category',
  incidentDescription: 'incident_description',
  estimatedLoss: 'estimated_loss',
  affectedAsset: 'affected_asset',
  contactName: 'contact_name',
  contactPhone: 'contact_phone',
  contactEmail: 'contact_email',
  declarationAccepted: 'declaration_accepted',
  draftStep: 'draft_step',
}

async function resolvePolicyForDraft(t, actor, policyNumber) {
  if (policyNumber === undefined) return undefined
  if (!policyNumber) return { policy_id: null }
  const policy = await t.findOne('policies', { policy_number: policyNumber.toUpperCase() })
  const staffOnBehalf = can(actor.roles, 'claims.create') && !actor.roles.includes(ROLES.CUSTOMER)
  if (!policy || (!staffOnBehalf && policy.holder_id !== actor.id)) {
    throw validationError('Policy not found for your account', [{ field: 'policyNumber', message: 'Policy not found for your account' }])
  }
  return { policy_id: policy.id, policy }
}

function mapDraftInput(input) {
  const out = {}
  for (const [key, column] of Object.entries(DRAFT_FIELD_MAP)) {
    if (input[key] !== undefined) out[column] = input[key]
  }
  if (input.declarationAccepted === true) out.declaration_accepted_at = new Date()
  if (input.declarationAccepted === false) out.declaration_accepted_at = null
  return out
}

// ---------------------------------------------------------------------------
// Drafts and submission
// ---------------------------------------------------------------------------
export async function createDraft(ctx, input) {
  requirePermission(ctx.actor, 'claims.create')
  return ctx.db.tx(async (t) => {
    const resolved = await resolvePolicyForDraft(t, ctx.actor, input.policyNumber)
    const customerId = resolved?.policy && !ctx.actor.roles.includes(ROLES.CUSTOMER) ? resolved.policy.holder_id : ctx.actor.id
    if (!ctx.actor.roles.includes(ROLES.CUSTOMER) && !resolved?.policy) {
      throw validationError('Staff must provide the policy number when creating a claim on behalf of a customer')
    }
    const claim = await t.insert('claims', {
      ...mapDraftInput(input),
      policy_id: resolved?.policy_id ?? null,
      claim_type: input.claimType ?? resolved?.policy?.policy_type ?? null,
      insured_name: input.insuredName ?? resolved?.policy?.insured_name ?? null,
      customer_id: customerId,
      created_by: ctx.actor.id,
      status: 'DRAFT',
    })
    await recordAudit(t, ctx.actor, { action: 'CLAIM_DRAFT_CREATED', entityType: 'claim', entityId: claim.id, claimId: claim.id, after: claim })
    return claim
  })
}

export async function updateClaim(ctx, id, input, kind) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    let patch
    if (kind === 'draft') {
      if (claim.status !== 'DRAFT') throw businessRule('CLAIM_NOT_EDITABLE', 'Only draft claims can be edited')
      if (claim.customer_id !== ctx.actor.id && claim.created_by !== ctx.actor.id) throw forbidden('You can only edit your own drafts')
      const resolved = await resolvePolicyForDraft(t, ctx.actor, input.policyNumber)
      patch = { ...mapDraftInput(input) }
      if (resolved) {
        patch.policy_id = resolved.policy_id
        if (resolved.policy) {
          patch.claim_type = input.claimType ?? resolved.policy.policy_type
          patch.insured_name = input.insuredName ?? claim.insured_name ?? resolved.policy.insured_name
        }
      }
    } else {
      requirePermission(ctx.actor, 'claims.updateMeta')
      requireNotOwnClaim(ctx.actor, claim)
      patch = {}
      if (input.priority) patch.priority = input.priority
      if (input.dueDate !== undefined) patch.due_date = input.dueDate
    }
    const updated = await t.updateById('claims', id, patch)
    await recordAudit(t, ctx.actor, {
      action: kind === 'draft' ? 'CLAIM_DRAFT_UPDATED' : 'CLAIM_UPDATED',
      entityType: 'claim',
      entityId: id,
      claimId: id,
      before: claim,
      after: updated,
    })
    return updated
  })
}

function autoPriority(estimatedLoss) {
  const amount = Number(estimatedLoss || 0)
  if (amount >= 200_000) return 'URGENT'
  if (amount >= 50_000) return 'HIGH'
  if (amount >= 5_000) return 'MEDIUM'
  return 'LOW'
}

export async function submitClaim(ctx, id, { submissionKey, confirmSeparateClaim }) {
  return ctx.db.tx(async (t) => {
    if (submissionKey) {
      const replay = await t.findOne('claims', { submission_key: submissionKey })
      if (replay) {
        if (replay.customer_id !== ctx.actor.id && replay.created_by !== ctx.actor.id) {
          throw conflict('Submission key already used', 'IDEMPOTENCY_KEY_REUSED')
        }
        return { claim: replay, replayed: true }
      }
    }

    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    if (claim.status !== 'DRAFT') {
      throw businessRule('ALREADY_SUBMITTED', `Claim ${claim.claim_number} has already been submitted`, {
        claimNumber: claim.claim_number,
      })
    }

    const ready = submissionReadySchema.safeParse(claim)
    if (!ready.success) {
      throw validationError(
        'The claim is incomplete',
        ready.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      )
    }

    const eligibility = await checkClaimEligibility(t, claim)
    if (!eligibility.eligible) {
      throw businessRule('POLICY_NOT_ELIGIBLE', `Policy is not eligible for this claim: ${eligibility.reasons.join('; ')}`, {
        reasons: eligibility.reasons,
      })
    }

    // Accidental duplicate detection: same policy, category and incident within 24 hours.
    const incident = new Date(claim.incident_at)
    const duplicates = await t.findMany('claims', {
      where: {
        id: { ne: claim.id },
        policy_id: claim.policy_id,
        incident_category: claim.incident_category,
        status: { nin: ['DRAFT', 'WITHDRAWN'] },
        incident_at: { gte: new Date(incident.getTime() - 86_400_000), lte: new Date(incident.getTime() + 86_400_000) },
      },
      columns: ['id', 'claim_number', 'status', 'incident_at', 'estimated_loss'],
      limit: 5,
    })
    if (duplicates.length && !confirmSeparateClaim) {
      throw conflict(
        'A claim for a similar incident on this policy already exists. Confirm that this is a separate incident to continue.',
        'POSSIBLE_DUPLICATE',
        { existing: duplicates.map((d) => ({ ...d, status_label: CUSTOMER_STATUS_LABELS[d.status] })) },
      )
    }

    const [{ claim_number: claimNumber }] = await t.query('select public.next_claim_number() as claim_number')
    const submitted = await transitionClaim(ctx, t, claim, 'SUBMITTED', {
      patch: {
        claim_number: claimNumber,
        submitted_at: new Date(),
        submission_key: submissionKey || null,
        possible_duplicate_of: duplicates[0]?.id || null,
        priority: autoPriority(claim.estimated_loss),
      },
    })

    if (duplicates.length) {
      await notify(ctx, t, {
        recipientIds: await userIdsWithRole(t, ROLES.CLAIMS_OPERATIONS),
        claimId: submitted.id,
        type: 'CLAIM_SUBMITTED',
        title: `Possible duplicate: ${submitted.claim_number}`,
        message: `Customer confirmed ${submitted.claim_number} is separate from ${duplicates[0].claim_number}. Please verify during intake.`,
        link: claimLink(submitted, false),
        email: false,
      })
    }
    return { claim: submitted, replayed: false }
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function buildListFilter(ctx, query) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden('Your role cannot view claims')
  const filters = [scope]
  const customerOnly = !isStaff(ctx.actor)

  if (query.status?.length) filters.push({ status: { in: query.status } })
  else if (!customerOnly) filters.push({ status: { ne: 'DRAFT' } })
  if (customerOnly) filters.push({ $or: [{ claim_number: { ne: null } }, { status: 'DRAFT' }] })
  if (query.claimType?.length) filters.push({ claim_type: { in: query.claimType } })
  if (query.priority?.length) filters.push({ priority: { in: query.priority } })
  if (query.from) filters.push({ submitted_at: { gte: query.from } })
  if (query.to) filters.push({ submitted_at: { lte: new Date(new Date(query.to).getTime() + 86_399_999) } })
  if (query.overdue === 'true') filters.push({ due_date: { lt: new Date() }, status: { in: ACTIVE_STATUSES } })
  if (query.escalated === 'true') filters.push({ escalation_level: { gt: 0 } })
  if (query.needsAdjuster === 'true') filters.push({ status: 'ADJUSTER_ASSIGNMENT', assigned_adjuster_id: null })

  if (query.assigneeId === 'unassigned') {
    filters.push({ assigned_owner_id: null, status: { in: ACTIVE_STATUSES } })
  } else if (query.assigneeId) {
    const id = query.assigneeId === 'me' ? ctx.actor.id : query.assigneeId
    filters.push({ $or: [{ assigned_owner_id: id }, { assigned_adjuster_id: id }, { assigned_reviewer_id: id }] })
  }

  if (query.search) {
    const term = `%${escapeLike(query.search)}%`
    const [policies, customers] = await Promise.all([
      ctx.db.findMany('policies', { where: { policy_number: { ilike: term } }, columns: ['id'], limit: 200 }),
      ctx.db.findMany('profiles', { where: { full_name: { ilike: term } }, columns: ['id'], limit: 200 }),
    ])
    filters.push({
      $or: [
        { claim_number: { ilike: term } },
        { insured_name: { ilike: term } },
        { contact_name: { ilike: term } },
        { policy_id: { in: policies.map((p) => p.id) } },
        { customer_id: { in: customers.map((c) => c.id) } },
      ],
    })
  }
  return { $and: filters }
}

export async function listClaims(ctx, query) {
  const where = await buildListFilter(ctx, query)
  const orderBy = [[query.sort, query.order], ['created_at', 'desc']]
  const [rows, total] = await Promise.all([
    ctx.db.findMany('claims', { where, orderBy, ...toOffset(query) }),
    ctx.db.count('claims', where),
  ])
  const policyIds = rows.map((r) => r.policy_id).filter(Boolean)
  const policies = policyIds.length
    ? await ctx.db.findMany('policies', { where: { id: { in: policyIds } }, columns: ['id', 'policy_number'] })
    : []
  const policyNumbers = Object.fromEntries(policies.map((p) => [p.id, p.policy_number]))
  const items = (await presentClaims(ctx.db, rows, ctx.actor)).map((c) => ({
    ...c,
    policy_number: policyNumbers[c.policy_id] || null,
  }))
  return { items, meta: pageMeta(query, total) }
}

export async function claimStats(ctx) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden('Your role cannot view claims')
  const where = { $and: [scope, { status: { ne: 'DRAFT' } }] }
  const byStatus = await ctx.db.groupCount('claims', 'status', where)
  const sum = (...statuses) => statuses.reduce((acc, s) => acc + (byStatus[s] || 0), 0)
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)

  const scopedIds = (await ctx.db.findMany('claims', { where, columns: ['id'] })).map((r) => r.id)
  const overdueTasks = await ctx.db.count('tasks', {
    status: { in: OPEN_TASK_STATUSES },
    due_at: { lt: new Date() },
    $or: [{ claim_id: { in: scopedIds } }, { assignee_id: ctx.actor.id }],
  })
  const myOpenTasks = await ctx.db.count('tasks', { status: { in: OPEN_TASK_STATUSES }, assignee_id: ctx.actor.id })
  const escalated = await ctx.db.count('claims', { $and: [where, { escalation_level: { gt: 0 } }, { status: { in: ACTIVE_STATUSES } }] })
  const overdueClaims = await ctx.db.count('claims', {
    $and: [where, { due_date: { lt: new Date() } }, { status: { in: ACTIVE_STATUSES } }],
  })

  return {
    total,
    newlySubmitted: sum('SUBMITTED'),
    awaitingVerification: sum('POLICY_VERIFICATION'),
    awaitingDocuments: sum('DOCUMENTS_REQUIRED'),
    inDocumentReview: sum('DOCUMENT_REVIEW'),
    awaitingAdjuster: sum('ADJUSTER_ASSIGNMENT'),
    underInvestigation: sum('INVESTIGATION'),
    awaitingApproval: sum('RESERVE_APPROVAL', 'SETTLEMENT_APPROVAL'),
    inCompliance: sum('COMPLIANCE_REVIEW'),
    awaitingPayment: sum('PAYMENT_PENDING', 'PAYMENT_FAILED'),
    paid: sum('PAID'),
    closed: sum('CLOSED'),
    rejected: sum('REJECTED'),
    onHold: sum('ON_HOLD'),
    overdueTasks,
    overdueClaims,
    escalated,
    myOpenTasks,
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, label: STATUS_LABELS[status], count })),
  }
}

export async function getClaimDetail(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const policy = claim.policy_id ? await ctx.db.findById('policies', claim.policy_id) : null

  if (isCustomerView(ctx.actor, claim)) {
    const required = REQUIRED_DOCUMENTS[claim.claim_type] || []
    const openRequests = await ctx.db.count('information_requests', { claim_id: id, status: 'OPEN' })
    return {
      claim: presentClaimForCustomer(claim),
      policy: presentPolicy(policy),
      requiredDocuments: required,
      openRequests,
      transitions: (await availableTransitions(ctx.db, claim, ctx.actor)).filter((tr) => tr.allowed || tr.to === 'WITHDRAWN'),
    }
  }

  const names = await profileMap(ctx.db, [
    claim.customer_id,
    claim.assigned_owner_id,
    claim.assigned_adjuster_id,
    claim.assigned_reviewer_id,
    claim.policy_verified_by,
    claim.document_exception_by,
  ])
  const currentTask = await ctx.db.findOne(
    'tasks',
    { claim_id: id, status: { in: OPEN_TASK_STATUSES } },
    { orderBy: [['is_mandatory', 'desc'], ['due_at', 'asc']] },
  )
  const missingDocs = await missingRequiredDocuments(ctx.db, claim)
  const eligibility = policy ? await checkClaimEligibility(ctx.db, claim) : null
  const [openTasks, openRequests, pendingDocs] = await Promise.all([
    ctx.db.count('tasks', { claim_id: id, status: { in: OPEN_TASK_STATUSES } }),
    ctx.db.count('information_requests', { claim_id: id, status: 'OPEN' }),
    ctx.db.count('documents', { claim_id: id, status: 'PENDING_REVIEW' }),
  ])
  const duplicateOf = claim.possible_duplicate_of
    ? await ctx.db.findOne('claims', { id: claim.possible_duplicate_of }, { columns: ['id', 'claim_number', 'status'] })
    : null

  return {
    claim: {
      ...presentClaimForStaff(claim, names),
      policy_verified_by_name: nameOf(names, claim.policy_verified_by),
      document_exception_by_name: nameOf(names, claim.document_exception_by),
    },
    policy: presentPolicy(policy),
    customer: names[claim.customer_id] || null,
    currentTask,
    eligibility,
    requiredDocuments: REQUIRED_DOCUMENTS[claim.claim_type] || [],
    missingDocuments: claim.document_exception_at ? [] : missingDocs,
    complianceHold: await hasActiveComplianceHold(ctx.db, id),
    duplicateOf,
    counts: { openTasks, openRequests, pendingDocs },
    intakeChecklist: INTAKE_CHECKLIST.map((item) => ({ ...item, ...(claim.intake_checklist?.[item.key] || { checked: false }) })),
    permissions: {
      tabs: visibleTabs(ctx.actor.roles),
      actions: permissionsFor(ctx.actor.roles),
    },
  }
}

export async function getTransitions(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  return availableTransitions(ctx.db, claim, ctx.actor)
}

export async function changeStatus(ctx, id, { toStatus, reason, customerMessage }) {
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    if (toStatus === 'SUBMITTED' && claim.status === 'DRAFT') {
      throw businessRule('USE_SUBMIT_ENDPOINT', 'Submit claims with POST /claims/:id/submit')
    }
    return transitionClaim(ctx, t, claim, toStatus, { reason, customerMessage })
  })
}

// ---------------------------------------------------------------------------
// Intake operations
// ---------------------------------------------------------------------------
export async function verifyPolicy(ctx, id, { verified, notes }) {
  requirePermission(ctx.actor, 'claims.verifyPolicy')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Policy verification is only possible during intake')
    }
    const policy = await t.findById('policies', claim.policy_id)
    const result = evaluatePolicyEligibility(policy, {
      customerId: claim.customer_id,
      incidentAt: claim.incident_at,
      claimType: claim.claim_type,
      incidentCategory: claim.incident_category,
    })
    if (verified && !result.eligible) {
      throw businessRule('POLICY_NOT_ELIGIBLE', `Policy cannot be verified: ${result.reasons.join('; ')}`, { reasons: result.reasons })
    }
    const updated = await t.updateById('claims', id, {
      policy_verified: verified,
      policy_verified_by: ctx.actor.id,
      policy_verified_at: new Date(),
      policy_verification_notes: notes || (verified ? 'Verified against policy record' : result.reasons.join('; ')),
      assigned_owner_id: claim.assigned_owner_id || ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: verified ? 'POLICY_VERIFIED' : 'POLICY_VERIFICATION_FAILED',
      entityType: 'claim',
      entityId: id,
      claimId: id,
      before: claim,
      after: updated,
      metadata: { checks: result.checks, reasons: result.reasons },
    })
    return { claim: updated, eligibility: result }
  })
}

export async function updateIntakeChecklist(ctx, id, { items }) {
  requirePermission(ctx.actor, 'claims.intakeChecklist')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'The intake checklist can only be changed during intake')
    }
    const checklist = { ...(claim.intake_checklist || {}) }
    const now = new Date().toISOString()
    for (const [key, checked] of Object.entries(items)) {
      checklist[key] = checked ? { checked: true, by: ctx.actor.id, by_name: ctx.actor.fullName, at: now } : { checked: false }
    }
    const updated = await t.updateById('claims', id, { intake_checklist: checklist })
    await recordAudit(t, ctx.actor, { action: 'INTAKE_CHECKLIST_UPDATED', entityType: 'claim', entityId: id, claimId: id, metadata: { items } })
    return updated
  })
}

export async function escalateClaim(ctx, id, { reason }) {
  requirePermission(ctx.actor, 'claims.escalate')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status) && claim.status !== 'ON_HOLD') {
      throw businessRule('INVALID_STAGE', 'Only open claims can be escalated')
    }
    if (claim.escalation_level >= 3) throw businessRule('MAX_ESCALATION', 'Claim is already at the highest escalation level')
    const updated = await t.updateById('claims', id, {
      escalation_level: claim.escalation_level + 1,
      escalated_at: new Date(),
      escalation_reason: reason,
      priority: ['LOW', 'MEDIUM'].includes(claim.priority) ? 'HIGH' : claim.priority === 'HIGH' ? 'URGENT' : claim.priority,
    })
    await t.insert('claim_notes', { claim_id: id, author_id: ctx.actor.id, visibility: 'INTERNAL', body: `Escalated to level ${updated.escalation_level}: ${reason}` })
    await recordAudit(t, ctx.actor, { action: 'CLAIM_ESCALATED', entityType: 'claim', entityId: id, claimId: id, before: claim, after: updated })
    await notify(ctx, t, {
      recipientIds: (await userIdsWithRole(t, ROLES.CLAIMS_MANAGER)).filter((u) => u !== ctx.actor.id),
      claimId: id,
      type: 'CLAIM_STATUS_CHANGED',
      title: `Escalation level ${updated.escalation_level}: ${claim.claim_number}`,
      message: reason,
      link: claimLink(claim, false),
    })
    return updated
  })
}

export async function recordDocumentException(ctx, id, { reason }) {
  requirePermission(ctx.actor, 'claims.documentException')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Document exceptions can only be recorded during document collection or review')
    }
    const missing = await missingRequiredDocuments(t, claim)
    const updated = await t.updateById('claims', id, {
      document_exception_reason: reason,
      document_exception_by: ctx.actor.id,
      document_exception_at: new Date(),
    })
    await t.insert('claim_notes', {
      claim_id: id,
      author_id: ctx.actor.id,
      visibility: 'INTERNAL',
      body: `Document exception recorded (waived: ${missing.join(', ') || 'none outstanding'}): ${reason}`,
    })
    await recordAudit(t, ctx.actor, {
      action: 'DOCUMENT_EXCEPTION_RECORDED',
      entityType: 'claim',
      entityId: id,
      claimId: id,
      before: claim,
      after: updated,
      metadata: { waived: missing },
    })
    return updated
  })
}

// ---------------------------------------------------------------------------
// Notes and timeline
// ---------------------------------------------------------------------------
export async function listNotes(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const where = { claim_id: id }
  if (isCustomerView(ctx.actor, claim)) where.visibility = 'CUSTOMER'
  const notes = await ctx.db.findMany('claim_notes', { where, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, notes.map((n) => n.author_id))
  return notes.map((n) => ({ ...n, author_name: nameOf(names, n.author_id) }))
}

export async function addNote(ctx, id, { body, visibility }) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id)
    requireStaffView(ctx.actor, claim)
    requirePermission(ctx.actor, visibility === 'CUSTOMER' ? 'claims.notes.customer' : 'claims.notes.internal')
    const note = await t.insert('claim_notes', { claim_id: id, author_id: ctx.actor.id, visibility, body })
    await recordAudit(t, ctx.actor, { action: 'NOTE_ADDED', entityType: 'claim_note', entityId: note.id, claimId: id, metadata: { visibility } })
    if (visibility === 'CUSTOMER') {
      await notify(ctx, t, {
        recipientIds: [claim.customer_id],
        claimId: id,
        type: 'CLAIM_STATUS_CHANGED',
        title: `Update on claim ${claim.claim_number}`,
        message: body.length > 280 ? `${body.slice(0, 277)}...` : body,
        link: claimLink(claim, true),
      })
    }
    return note
  })
}

export async function getTimeline(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const customer = isCustomerView(ctx.actor, claim)
  const events = []

  const history = await ctx.db.findMany('claim_status_history', {
    where: customer ? { claim_id: id, customer_visible: true } : { claim_id: id },
    orderBy: [['created_at', 'asc']],
  })
  for (const h of history) {
    events.push({
      id: `status-${h.id}`,
      type: 'STATUS',
      at: h.created_at,
      title: customer ? CUSTOMER_STATUS_LABELS[h.to_status] : `${STATUS_LABELS[h.from_status] || 'New'} → ${STATUS_LABELS[h.to_status]}`,
      description: customer ? h.customer_message : h.reason,
      actorId: customer ? null : h.changed_by,
      status: h.to_status,
    })
  }

  const notes = await ctx.db.findMany('claim_notes', {
    where: customer ? { claim_id: id, visibility: 'CUSTOMER' } : { claim_id: id },
  })
  for (const n of notes) {
    events.push({
      id: `note-${n.id}`,
      type: n.visibility === 'CUSTOMER' ? 'CUSTOMER_NOTE' : 'INTERNAL_NOTE',
      at: n.created_at,
      title: n.visibility === 'CUSTOMER' ? 'Message from claims team' : 'Internal note',
      description: n.body,
      actorId: customer ? null : n.author_id,
    })
  }

  const documents = await ctx.db.findMany('documents', { where: { claim_id: id } })
  for (const d of documents) {
    events.push({ id: `doc-up-${d.id}`, type: 'DOCUMENT', at: d.uploaded_at, title: `Document uploaded: ${d.file_name}`, description: humanize(d.category), actorId: customer ? null : d.uploaded_by })
    if (d.reviewed_at) {
      events.push({
        id: `doc-rv-${d.id}`,
        type: 'DOCUMENT',
        at: d.reviewed_at,
        title: `Document ${d.status === 'REJECTED' ? 'rejected' : 'accepted'}: ${d.file_name}`,
        description: d.status === 'REJECTED' ? d.rejection_reason : d.review_comment,
        actorId: customer ? null : d.reviewed_by,
      })
    }
  }

  const requests = await ctx.db.findMany('information_requests', { where: { claim_id: id } })
  for (const r of requests) {
    events.push({ id: `req-${r.id}`, type: 'REQUEST', at: r.created_at, title: r.request_type === 'DOCUMENT' ? `Document requested: ${humanize(r.document_category)}` : 'Information requested', description: r.message, actorId: customer ? null : r.requested_by })
  }

  if (!customer) {
    const audits = await ctx.db.findMany('audit_logs', {
      where: { claim_id: id, action: { nin: ['CLAIM_STATUS_CHANGED', 'NOTE_ADDED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REVIEWED', 'INFORMATION_REQUESTED'] } },
      orderBy: [['created_at', 'asc']],
      limit: 300,
    })
    for (const a of audits) {
      events.push({ id: `audit-${a.id}`, type: 'AUDIT', at: a.created_at, title: humanize(a.action), description: a.metadata?.reason || a.metadata?.comments || null, actorId: a.actor_id })
    }
  }

  const names = customer ? {} : await profileMap(ctx.db, events.map((e) => e.actorId))
  return events
    .map((e) => ({ ...e, actorName: nameOf(names, e.actorId) }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

export async function deleteDraft(ctx, id) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    if (claim.status !== 'DRAFT') throw businessRule('CLAIM_NOT_EDITABLE', 'Only drafts can be discarded')
    if (claim.customer_id !== ctx.actor.id && claim.created_by !== ctx.actor.id) throw notFound('Claim not found')
    return transitionClaim(ctx, t, claim, 'WITHDRAWN', { reason: 'Draft discarded by claimant' })
  })
}
