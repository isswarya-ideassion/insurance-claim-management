import { ROLES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { assertReserveReviewer, reserveReviewCapability } from '../../services/authority.service.js'
import { notify } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { formatInr, roundMoney } from '../../utils/format.js'
import { setReserve } from '../evaluations/evaluations.service.js'

/** The reserve ledger of a claim, newest first; pending entries carry the caller's review capability. */
export async function listClaimReserves(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'reserves')
  const rows = await ctx.db.findMany('reserves', { where: { claim_id: claimId }, orderBy: [['effective_at', 'desc'], ['created_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.set_by, r.approved_by]))
  const out = []
  for (const r of rows) {
    out.push({
      ...r,
      set_by_name: nameOf(names, r.set_by),
      approved_by_name: nameOf(names, r.approved_by),
      ...(r.approval_status === 'PENDING_REVIEW' ? await reserveReviewCapability(ctx.db, ctx.actor, r, claim) : {}),
    })
  }
  return out
}

export async function reserveQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.OPS_MANAGER, ROLES.COMPLIANCE_SECURITY])) throw forbidden('The reserve review queue requires Claims Manager access')
  const where = { approval_status: 'PENDING_REVIEW' }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('reserves', { where, orderBy: [['effective_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('reserves', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } }) : []
  const evaluations = rows.length
    ? await ctx.db.findMany('evaluations', { where: { id: { in: rows.map((r) => r.evaluation_id).filter(Boolean) } } })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const evaluationMap = Object.fromEntries(evaluations.map((a) => [a.id, a]))
  const names = await profileMap(ctx.db, [...rows.map((r) => r.set_by), ...claims.map((c) => c.customer_id)])
  const items = []
  for (const r of rows) {
    const claim = claimMap[r.claim_id] || {}
    const evaluation = evaluationMap[r.evaluation_id] || null
    items.push({
      ...r,
      claim_number: claim.claim_number,
      claim_type: claim.claim_type,
      claim_priority: claim.priority,
      claim_segment: claim.segment,
      customer_name: nameOf(names, claim.customer_id),
      claimed_amount: claim.estimated_loss,
      set_by_name: nameOf(names, r.set_by),
      evaluation: evaluation && {
        id: evaluation.id,
        version_no: evaluation.version_no,
        loss_value: evaluation.loss_value,
        recommended_settlement: evaluation.recommended_settlement,
        decision: evaluation.decision,
        findings: evaluation.findings,
      },
      ...(await reserveReviewCapability(ctx.db, ctx.actor, r, claim)),
    })
  }
  return { items, meta: pageMeta(query, total) }
}

/**
 * Manager reserve review (PRD 3.5 decision node): approve, modify (a new ledger
 * entry with the manager's amount), reject or return. Each decision is an
 * immutable RESERVE review row recording the reviewer's authority.
 */
export async function reviewReserve(ctx, reserveId, { decision, comments, modifiedAmount }) {
  requirePermission(ctx.actor, 'reserves.review')
  return ctx.db.tx(async (t) => {
    const reserve = await t.findOne('reserves', { id: reserveId }, { forUpdate: true })
    if (!reserve) throw notFound('Reserve not found')
    await loadAccessibleClaim(t, ctx.actor, reserve.claim_id)
    const claim = await lockClaim(t, reserve.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (reserve.approval_status !== 'PENDING_REVIEW') {
      throw businessRule('ALREADY_DECIDED', `This reserve is already ${reserve.approval_status.toLowerCase().replace('_', ' ')}`)
    }
    const amount = decision === 'MODIFIED' ? roundMoney(modifiedAmount) : reserve.amount
    if (decision === 'MODIFIED' && Number(amount) === Number(reserve.amount)) {
      throw validationError('A modified reserve needs a different amount; approve it instead')
    }
    await assertReserveReviewer(t, ctx.actor, reserve, claim, { decision, amount })

    const now = new Date()
    const review = await t.insert('reviews', {
      claim_id: claim.id,
      checkpoint_type: 'RESERVE',
      subject_type: 'reserve',
      subject_id: reserve.id,
      status: 'DECIDED',
      outcome: decision,
      amount,
      requested_by: reserve.set_by,
      reviewer_id: ctx.actor.id,
      decided_by: ctx.actor.id,
      comments: comments || null,
      reviewed_at: now,
    })
    const updatedReserve = await t.updateById('reserves', reserve.id, {
      approval_status: decision,
      approved_by: ['APPROVED', 'MODIFIED'].includes(decision) ? ctx.actor.id : null,
      approved_at: now,
      review_comment: comments || null,
      updated_by: ctx.actor.id,
    })
    let effective = updatedReserve
    if (decision === 'MODIFIED') {
      effective = await t.insert('reserves', {
        claim_id: claim.id,
        evaluation_id: reserve.evaluation_id,
        coverage_line: reserve.coverage_line,
        amount,
        prev_amount: reserve.amount,
        currency: reserve.currency,
        reason_code: 'MANAGER_MODIFIED',
        notes: comments || 'Amount modified in manager review',
        set_by: reserve.set_by,
        created_by: ctx.actor.id,
        authority_ok: false,
        approval_status: 'APPROVED',
        approved_by: ctx.actor.id,
        approved_at: now,
      })
    }
    await recordAudit(t, ctx.actor, {
      action: 'RESERVE_REVIEWED',
      entityType: 'reserve',
      entityId: reserve.id,
      claimId: claim.id,
      before: reserve,
      after: updatedReserve,
      metadata: { decision, comments, reviewId: review.id, approverLimit: review.approver_limit, modifiedAmount: decision === 'MODIFIED' ? amount : undefined },
    })

    const accepted = ['APPROVED', 'MODIFIED'].includes(decision)
    if (reserve.evaluation_id) {
      await t.updateById('evaluations', reserve.evaluation_id, {
        status: accepted ? 'APPROVED' : 'RETURNED',
        reviewed_by: ctx.actor.id,
        reviewed_at: now,
        review_comment: comments || null,
      })
    }

    let updatedClaim = claim
    if (claim.status === 'RESERVE_APPROVAL') {
      updatedClaim = accepted
        ? await transitionClaim(ctx, t, claim, 'COMPLIANCE_REVIEW', { reason: `Reserve of ${formatInr(effective.amount)} ${decision === 'MODIFIED' ? 'modified and approved' : 'approved'}` })
        : await transitionClaim(ctx, t, claim, 'INVESTIGATION', { reason: `Reserve ${decision.toLowerCase()}: ${comments}` })
    }

    await notify(ctx, t, {
      recipientIds: [reserve.set_by],
      claimId: claim.id,
      type: decision === 'REJECTED' ? 'APPROVAL_REJECTED' : 'APPROVAL_DECISION',
      title: `Reserve ${decision.toLowerCase()}: ${claim.claim_number}`,
      message: comments || `Reserve of ${formatInr(effective.amount)} was ${decision.toLowerCase()}.`,
      link: `/claims/${claim.id}?tab=reserves`,
    })
    return { review, reserve: effective, claim: updatedClaim }
  })
}

/** Adjuster revises a reserve during investigation (posted within authority, otherwise escalated). */
export async function reviseReserve(ctx, claimId, input) {
  requirePermission(ctx.actor, 'reserves.set')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (claim.assigned_adjuster_id !== ctx.actor.id) throw forbidden('Only the assigned adjuster can set reserves on this claim')
    if (claim.status !== 'INVESTIGATION') throw businessRule('INVALID_STAGE', 'Reserves are revised during investigation')
    const latestEvaluation = await t.findOne('evaluations', { claim_id: claimId }, { orderBy: [['version_no', 'desc']] })
    return setReserve(ctx, t, claim, {
      evaluationId: latestEvaluation?.id || null,
      coverageLine: input.coverageLine,
      amount: input.amount,
      reasonCode: input.reasonCode,
      notes: input.notes,
      aiRunRef: input.aiRunRef || null,
    })
  })
}
