import { ROLES, ACTIVE_STATUSES, COMPLIANCE_CHECKLIST, OPEN_COMPLIANCE_STATUSES, STATUS_LABELS } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { createSettlementRequest } from '../settlements/settlements.service.js'

export const SEVERITY_FACTOR = { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 }
const COMPLIANCE = { checkpoint_type: 'COMPLIANCE' }

async function flagsByReview(t, reviews) {
  const claimIds = [...new Set(reviews.map((r) => r.claim_id))]
  if (!claimIds.length) return {}
  const rows = await t.findMany('claim_fraud_flags', { where: { claim_id: { in: claimIds } }, orderBy: [['created_at', 'asc']] })
  const out = {}
  for (const f of rows) (out[f.claim_id] ||= []).push(f)
  return out
}

function decorate(rows, names, flags) {
  return rows.map((r) => ({
    ...r,
    // Compatibility names for the compliance screen.
    decision_notes: r.comments,
    decided_at: r.reviewed_at,
    risk_flags: (flags[r.claim_id] || []).map((f) => ({ id: f.id, code: f.code, severity: f.severity, note: f.note, resolved: f.resolved, contribution: f.contribution })),
    reviewer_name: nameOf(names, r.reviewer_id),
    decided_by_name: nameOf(names, r.decided_by),
    hold_placed_by_name: nameOf(names, r.hold_placed_by),
    created_by_name: nameOf(names, r.created_by),
  }))
}

async function names(t, rows) {
  return profileMap(t, rows.flatMap((r) => [r.reviewer_id, r.decided_by, r.hold_placed_by, r.created_by]))
}

export async function listClaimReviews(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'compliance')
  const rows = await ctx.db.findMany('reviews', { where: { claim_id: claimId, ...COMPLIANCE }, orderBy: [['created_at', 'desc']] })
  return decorate(rows, await names(ctx.db, rows), await flagsByReview(ctx.db, rows))
}

export async function complianceQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.COMPLIANCE_SECURITY, ROLES.OPS_MANAGER])) {
    throw forbidden('The compliance queue requires Compliance & Security or Claims Manager access')
  }
  const where = { ...COMPLIANCE, status: { in: query.status?.length ? query.status : OPEN_COMPLIANCE_STATUSES } }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('reviews', { where, orderBy: [['hold_active', 'desc'], ['created_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('reviews', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const nameMap = await profileMap(ctx.db, [...rows.flatMap((r) => [r.reviewer_id, r.decided_by, r.hold_placed_by, r.created_by]), ...claims.map((c) => c.customer_id)])
  return {
    items: decorate(rows, nameMap, await flagsByReview(ctx.db, rows)).map((r) => {
      const c = claimMap[r.claim_id] || {}
      return {
        ...r,
        claim_number: c.claim_number,
        claim_status: c.status,
        claim_type: c.claim_type,
        claim_priority: c.priority,
        estimated_loss: c.estimated_loss,
        fraud_score: c.fraud_score,
        customer_name: nameOf(nameMap, c.customer_id),
      }
    }),
    meta: pageMeta(query, total),
  }
}

/** Records new risk flags and updates existing ones (resolution, severity, note). The fraud score follows by trigger. */
async function saveFlags(ctx, t, claim, review, riskFlags) {
  if (!riskFlags?.length) return
  const codes = Object.fromEntries((await t.findMany('fraud_reason_codes', { where: { active: true } })).map((c) => [c.code, c]))
  for (const f of riskFlags) {
    if (f.id) {
      const existing = await t.findOne('claim_fraud_flags', { id: f.id, claim_id: claim.id })
      if (!existing) throw notFound('Risk flag not found on this claim')
      await t.updateById('claim_fraud_flags', f.id, {
        severity: f.severity,
        contribution: Math.round(codes[existing.code].weight * SEVERITY_FACTOR[f.severity]),
        note: f.note ?? existing.note,
        resolved: f.resolved,
        resolved_by: f.resolved && !existing.resolved ? ctx.actor.id : existing.resolved_by,
        resolved_at: f.resolved && !existing.resolved ? new Date() : existing.resolved_at,
      })
    } else {
      if (!codes[f.code]) throw businessRule('UNKNOWN_REASON_CODE', `${f.code} is not an active fraud reason code`)
      await t.insert('claim_fraud_flags', {
        claim_id: claim.id,
        code: f.code,
        severity: f.severity,
        contribution: Math.round(codes[f.code].weight * SEVERITY_FACTOR[f.severity]),
        note: f.note || null,
        resolved: f.resolved,
        resolved_by: f.resolved ? ctx.actor.id : null,
        resolved_at: f.resolved ? new Date() : null,
        review_id: review.id,
        created_by: ctx.actor.id,
      })
    }
  }
}

export async function openReview(ctx, claimId, { placeHold, notes, riskFlags }) {
  requirePermission(ctx.actor, 'compliance.review')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (![...ACTIVE_STATUSES, 'ON_HOLD'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', `Compliance reviews cannot be opened on a claim in ${STATUS_LABELS[claim.status]}`)
    }
    const open = await t.findOne('reviews', { claim_id: claimId, ...COMPLIANCE, status: { in: OPEN_COMPLIANCE_STATUSES } })
    if (open) throw businessRule('REVIEW_ALREADY_OPEN', 'An open compliance review already exists for this claim', { reviewId: open.id })
    const now = new Date()
    const review = await t.insert('reviews', {
      claim_id: claimId,
      ...COMPLIANCE,
      subject_type: 'claim',
      subject_id: claimId,
      status: placeHold ? 'HOLD' : 'IN_REVIEW',
      comments: notes,
      hold_active: placeHold,
      hold_placed_by: placeHold ? ctx.actor.id : null,
      hold_placed_at: placeHold ? now : null,
      reviewer_id: ctx.actor.id,
      created_by: ctx.actor.id,
    })
    await saveFlags(ctx, t, claim, review, riskFlags)
    await recordAudit(t, ctx.actor, {
      action: placeHold ? 'COMPLIANCE_HOLD_PLACED' : 'COMPLIANCE_REVIEW_OPENED',
      entityType: 'review',
      entityId: review.id,
      claimId,
      after: review,
      metadata: { reason: notes, flags: riskFlags?.map((f) => f.code) },
    })
    if (placeHold) await notifyHold(ctx, t, claim, notes)
    return review
  })
}

export async function updateReview(ctx, id, input) {
  requirePermission(ctx.actor, 'compliance.review')
  return ctx.db.tx(async (t) => {
    const review = await t.findOne('reviews', { id, ...COMPLIANCE }, { forUpdate: true })
    if (!review) throw notFound('Compliance review not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, review.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!OPEN_COMPLIANCE_STATUSES.includes(review.status)) throw businessRule('REVIEW_CLOSED', 'Decided reviews cannot be edited')
    const patch = {}
    if (input.checklist) patch.checklist = { ...(review.checklist || {}), ...input.checklist }
    if (input.evidence) patch.evidence = input.evidence
    if (input.decisionNotes !== undefined) patch.comments = input.decisionNotes
    if (input.escalationNotes !== undefined) patch.escalation_notes = input.escalationNotes
    if (review.status === 'PENDING') patch.status = 'IN_REVIEW'
    if (!review.reviewer_id) patch.reviewer_id = ctx.actor.id
    const updated = Object.keys(patch).length ? await t.updateById('reviews', id, patch) : review
    await saveFlags(ctx, t, claim, review, input.riskFlags)
    await recordAudit(t, ctx.actor, { action: 'COMPLIANCE_REVIEW_UPDATED', entityType: 'review', entityId: id, claimId: review.claim_id, before: review, after: updated })
    return updated
  })
}

async function notifyHold(ctx, t, claim, notes) {
  const managers = await userIdsWithRole(t, ROLES.OPS_MANAGER)
  await notify(ctx, t, {
    recipientIds: [claim.assigned_owner_id, claim.assigned_adjuster_id, ...managers].filter((id) => id && id !== ctx.actor.id),
    claimId: claim.id,
    type: 'COMPLIANCE_HOLD',
    title: `Compliance hold: ${claim.claim_number}`,
    message: `A compliance hold blocks settlement and payment until cleared. ${notes}`,
    link: claimLink(claim, false),
  })
}

export async function decideReview(ctx, id, { decision, notes, exceptionReason }) {
  requirePermission(ctx.actor, 'compliance.review')
  return ctx.db.tx(async (t) => {
    const review = await t.findOne('reviews', { id, ...COMPLIANCE }, { forUpdate: true })
    if (!review) throw notFound('Compliance review not found')
    await loadAccessibleClaim(t, ctx.actor, review.claim_id)
    const claim = await lockClaim(t, review.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!OPEN_COMPLIANCE_STATUSES.includes(review.status)) throw businessRule('REVIEW_CLOSED', 'This review has already been decided')

    const now = new Date()
    let patch
    if (decision === 'CLEAR' || decision === 'EXCEPTION') {
      if (decision === 'CLEAR') {
        const missing = COMPLIANCE_CHECKLIST.filter((i) => !review.checklist?.[i.key])
        if (missing.length) {
          throw businessRule('CHECKLIST_INCOMPLETE', `Complete the compliance checklist first: ${missing.map((m) => m.label).join(', ')}`)
        }
        const highFlags = await t.count('claim_fraud_flags', { claim_id: claim.id, severity: 'HIGH', resolved: false })
        if (highFlags) {
          throw businessRule('HIGH_RISK_UNRESOLVED', 'Unresolved high-severity risk flags require an approved exception rather than a clearance')
        }
      }
      patch = {
        status: decision === 'CLEAR' ? 'CLEARED' : 'EXCEPTION_APPROVED',
        hold_active: false,
        exception_reason: decision === 'EXCEPTION' ? exceptionReason : null,
        comments: notes || review.comments,
        decided_by: ctx.actor.id,
        reviewed_at: now,
      }
    } else if (decision === 'HOLD') {
      patch = { status: 'HOLD', hold_active: true, hold_placed_by: ctx.actor.id, hold_placed_at: now, comments: notes }
    } else {
      patch = { status: 'ESCALATED', hold_active: true, escalation_notes: notes, hold_placed_by: review.hold_placed_by || ctx.actor.id, hold_placed_at: review.hold_placed_at || now }
    }
    if (!review.reviewer_id) patch.reviewer_id = ctx.actor.id

    const updated = await t.updateById('reviews', id, patch)
    await recordAudit(t, ctx.actor, {
      action: `COMPLIANCE_${decision}`,
      entityType: 'review',
      entityId: id,
      claimId: claim.id,
      before: review,
      after: updated,
      metadata: { reason: notes || exceptionReason },
    })

    let claimAfter = claim
    let settlement = null
    if (decision === 'HOLD') {
      await notifyHold(ctx, t, claim, notes)
    } else if (decision === 'ESCALATE') {
      await notify(ctx, t, {
        recipientIds: (await userIdsWithRole(t, ROLES.OPS_MANAGER)).filter((m) => m !== ctx.actor.id),
        claimId: claim.id,
        type: 'COMPLIANCE_HOLD',
        title: `Compliance escalation: ${claim.claim_number}`,
        message: notes,
        link: claimLink(claim, false),
      })
    } else if (claim.status === 'COMPLIANCE_REVIEW' && !(await hasActiveComplianceHold(t, claim.id))) {
      claimAfter = await transitionClaim(ctx, t, claim, 'SETTLEMENT_APPROVAL', {
        reason: decision === 'CLEAR' ? 'Compliance cleared' : `Compliance exception approved: ${exceptionReason}`,
      })
      settlement = await createSettlementRequest(ctx, t, claimAfter)
      if (!settlement) {
        await notify(ctx, t, {
          recipientIds: (await userIdsWithRole(t, ROLES.OPS_MANAGER)).filter((m) => m !== ctx.actor.id),
          claimId: claim.id,
          type: 'APPROVAL_REQUIRED',
          title: `Decision required: ${claim.claim_number}`,
          message: 'Compliance cleared. The adjuster recommended denial — a manager decision is required.',
          link: `/claims/${claim.id}?tab=approvals`,
        })
      }
    }
    return { review: updated, claim: claimAfter, settlement }
  })
}
