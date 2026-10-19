import { ROLES, ACTIVE_STATUSES, COMPLIANCE_CHECKLIST, STATUS_LABELS } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const OPEN_STATUSES = ['PENDING', 'IN_REVIEW', 'HOLD', 'ESCALATED']

function decorate(rows, names) {
  return rows.map((r) => ({
    ...r,
    reviewer_name: nameOf(names, r.reviewer_id),
    decided_by_name: nameOf(names, r.decided_by),
    hold_placed_by_name: nameOf(names, r.hold_placed_by),
    created_by_name: nameOf(names, r.created_by),
  }))
}

export async function listClaimReviews(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'compliance')
  const rows = await ctx.db.findMany('compliance_reviews', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.reviewer_id, r.decided_by, r.hold_placed_by, r.created_by]))
  return decorate(rows, names)
}

export async function complianceQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.COMPLIANCE_OFFICER, ROLES.CLAIMS_MANAGER, ROLES.AUDITOR])) {
    throw forbidden('Compliance queue requires compliance, manager or auditor access')
  }
  const where = { status: { in: query.status?.length ? query.status : OPEN_STATUSES } }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('compliance_reviews', { where, orderBy: [['hold_active', 'desc'], ['created_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('compliance_reviews', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const names = await profileMap(ctx.db, [...rows.flatMap((r) => [r.reviewer_id, r.decided_by, r.hold_placed_by, r.created_by]), ...claims.map((c) => c.customer_id)])
  return {
    items: decorate(rows, names).map((r) => {
      const c = claimMap[r.claim_id] || {}
      return {
        ...r,
        claim_number: c.claim_number,
        claim_status: c.status,
        claim_type: c.claim_type,
        claim_priority: c.priority,
        estimated_loss: c.estimated_loss,
        customer_name: nameOf(names, c.customer_id),
      }
    }),
    meta: pageMeta(query, total),
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
    const open = await t.findOne('compliance_reviews', { claim_id: claimId, status: { in: OPEN_STATUSES } })
    if (open) throw businessRule('REVIEW_ALREADY_OPEN', 'An open compliance review already exists for this claim', { reviewId: open.id })
    const now = new Date()
    const review = await t.insert('compliance_reviews', {
      claim_id: claimId,
      status: placeHold ? 'HOLD' : 'IN_REVIEW',
      risk_flags: riskFlags,
      decision_notes: notes,
      hold_active: placeHold,
      hold_placed_by: placeHold ? ctx.actor.id : null,
      hold_placed_at: placeHold ? now : null,
      reviewer_id: ctx.actor.id,
      created_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: placeHold ? 'COMPLIANCE_HOLD_PLACED' : 'COMPLIANCE_REVIEW_OPENED',
      entityType: 'compliance_review',
      entityId: review.id,
      claimId,
      after: review,
      metadata: { reason: notes },
    })
    if (placeHold) await notifyHold(ctx, t, claim, notes)
    return review
  })
}

export async function updateReview(ctx, id, input) {
  requirePermission(ctx.actor, 'compliance.review')
  return ctx.db.tx(async (t) => {
    const review = await t.findOne('compliance_reviews', { id }, { forUpdate: true })
    if (!review) throw notFound('Compliance review not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, review.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!OPEN_STATUSES.includes(review.status)) throw businessRule('REVIEW_CLOSED', 'Decided reviews cannot be edited')
    const patch = {}
    if (input.checklist) patch.checklist = { ...(review.checklist || {}), ...input.checklist }
    if (input.riskFlags) patch.risk_flags = input.riskFlags
    if (input.evidence) patch.evidence = input.evidence
    if (input.decisionNotes !== undefined) patch.decision_notes = input.decisionNotes
    if (input.escalationNotes !== undefined) patch.escalation_notes = input.escalationNotes
    if (review.status === 'PENDING') patch.status = 'IN_REVIEW'
    if (!review.reviewer_id) patch.reviewer_id = ctx.actor.id
    const updated = await t.updateById('compliance_reviews', id, patch)
    await recordAudit(t, ctx.actor, { action: 'COMPLIANCE_REVIEW_UPDATED', entityType: 'compliance_review', entityId: id, claimId: review.claim_id, before: review, after: updated })
    return updated
  })
}

async function notifyHold(ctx, t, claim, notes) {
  const managers = await userIdsWithRole(t, ROLES.CLAIMS_MANAGER)
  await notify(ctx, t, {
    recipientIds: [claim.assigned_owner_id, claim.assigned_adjuster_id, ...managers].filter((id) => id && id !== ctx.actor.id),
    claimId: claim.id,
    type: 'COMPLIANCE_HOLD',
    title: `Compliance hold: ${claim.claim_number}`,
    message: `A compliance hold blocks settlement and payment until cleared. ${notes}`,
    link: claimLink(claim, false),
  })
}

async function createSettlementRequest(ctx, t, claim) {
  const assessment = await t.findOne('assessments', { claim_id: claim.id, status: 'APPROVED' }, { orderBy: [['version_no', 'desc']] })
  if (!assessment || assessment.recommendation === 'DENY' || !(Number(assessment.recommended_settlement) > 0)) return null
  const existing = await t.findOne('settlements', { claim_id: claim.id, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } })
  if (existing) return existing
  const policy = await t.findById('policies', claim.policy_id)
  const settlement = await t.insert('settlements', {
    claim_id: claim.id,
    assessment_id: assessment.id,
    amount: assessment.recommended_settlement,
    beneficiary_name: policy?.insured_name || claim.insured_name,
    beneficiary_bank: policy?.payout_bank_name || null,
    beneficiary_account: policy?.payout_account_number || null,
    notes: `Settlement per assessment v${assessment.version_no} (${assessment.recommendation})`,
    requested_by: assessment.adjuster_id,
  })
  await recordAudit(t, ctx.actor, { action: 'SETTLEMENT_REQUESTED', entityType: 'settlement', entityId: settlement.id, claimId: claim.id, after: settlement })
  return settlement
}

export async function decideReview(ctx, id, { decision, notes, exceptionReason }) {
  requirePermission(ctx.actor, 'compliance.review')
  return ctx.db.tx(async (t) => {
    const review = await t.findOne('compliance_reviews', { id }, { forUpdate: true })
    if (!review) throw notFound('Compliance review not found')
    await loadAccessibleClaim(t, ctx.actor, review.claim_id)
    const claim = await lockClaim(t, review.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!OPEN_STATUSES.includes(review.status)) throw businessRule('REVIEW_CLOSED', 'This review has already been decided')

    const now = new Date()
    let patch
    if (decision === 'CLEAR' || decision === 'EXCEPTION') {
      if (decision === 'CLEAR') {
        const missing = COMPLIANCE_CHECKLIST.filter((i) => !review.checklist?.[i.key])
        if (missing.length) {
          throw businessRule('CHECKLIST_INCOMPLETE', `Complete the compliance checklist first: ${missing.map((m) => m.label).join(', ')}`)
        }
        const highFlags = (review.risk_flags || []).filter((f) => f.severity === 'HIGH' && !f.resolved)
        if (highFlags.length) {
          throw businessRule('HIGH_RISK_UNRESOLVED', 'Unresolved high-severity risk flags require an approved exception rather than a clearance')
        }
      }
      patch = {
        status: decision === 'CLEAR' ? 'CLEARED' : 'EXCEPTION_APPROVED',
        hold_active: false,
        exception_reason: decision === 'EXCEPTION' ? exceptionReason : null,
        decision_notes: notes || review.decision_notes,
        decided_by: ctx.actor.id,
        decided_at: now,
      }
    } else if (decision === 'HOLD') {
      patch = { status: 'HOLD', hold_active: true, hold_placed_by: ctx.actor.id, hold_placed_at: now, decision_notes: notes }
    } else {
      patch = { status: 'ESCALATED', hold_active: true, escalation_notes: notes, hold_placed_by: review.hold_placed_by || ctx.actor.id, hold_placed_at: review.hold_placed_at || now }
    }
    if (!review.reviewer_id) patch.reviewer_id = ctx.actor.id

    const updated = await t.updateById('compliance_reviews', id, patch)
    await recordAudit(t, ctx.actor, {
      action: `COMPLIANCE_${decision}`,
      entityType: 'compliance_review',
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
        recipientIds: (await userIdsWithRole(t, ROLES.CLAIMS_MANAGER)).filter((m) => m !== ctx.actor.id),
        claimId: claim.id,
        type: 'COMPLIANCE_HOLD',
        title: `Compliance escalation: ${claim.claim_number}`,
        message: notes,
        link: claimLink(claim, false),
      })
    } else if (claim.status === 'COMPLIANCE_REVIEW' && !(await hasActiveComplianceHold(t, claim.id))) {
      settlement = await createSettlementRequest(ctx, t, claim)
      claimAfter = await transitionClaim(ctx, t, claim, 'SETTLEMENT_APPROVAL', {
        reason: decision === 'CLEAR' ? 'Compliance cleared' : `Compliance exception approved: ${exceptionReason}`,
      })
      await notify(ctx, t, {
        recipientIds: (await userIdsWithRole(t, ROLES.CLAIMS_MANAGER)).filter((m) => m !== ctx.actor.id),
        claimId: claim.id,
        type: 'APPROVAL_REQUIRED',
        title: `Settlement approval required: ${claim.claim_number}`,
        message: settlement
          ? `Settlement of ${Number(settlement.amount).toFixed(2)} awaits approval.`
          : 'Compliance cleared. The adjuster recommended denial — a manager decision is required.',
        link: `/claims/${claim.id}?tab=approvals`,
      })
    }
    return { review: updated, claim: claimAfter, settlement }
  })
}
