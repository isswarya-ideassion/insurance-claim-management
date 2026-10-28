import { ROLES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { assertApprovalAuthority, approvalCapability } from '../../services/approvalAuthority.js'

export async function listClaimReserves(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'reserves')
  const rows = await ctx.db.findMany('reserves', { where: { claim_id: claimId }, orderBy: [['requested_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.map((r) => r.requested_by))
  return rows.map((r) => ({
    ...r,
    requested_by_name: nameOf(names, r.requested_by),
    ...(r.status === 'PENDING_APPROVAL' ? approvalCapability(ctx.actor, { amount: r.amount, requestedBy: r.requested_by }) : {}),
  }))
}

export async function reserveQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.CLAIMS_MANAGER, ROLES.AUDITOR])) throw forbidden('Reserve queue requires manager access')
  const where = { status: 'PENDING_APPROVAL' }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('reserves', { where, orderBy: [['requested_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('reserves', where),
  ])
  const claims = rows.length
    ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } })
    : []
  const assessments = rows.length
    ? await ctx.db.findMany('assessments', { where: { id: { in: rows.map((r) => r.assessment_id).filter(Boolean) } } })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const assessmentMap = Object.fromEntries(assessments.map((a) => [a.id, a]))
  const names = await profileMap(ctx.db, [...rows.map((r) => r.requested_by), ...claims.map((c) => c.customer_id)])
  return {
    items: rows.map((r) => {
      const claim = claimMap[r.claim_id] || {}
      const assessment = assessmentMap[r.assessment_id] || null
      return {
        ...r,
        claim_number: claim.claim_number,
        claim_type: claim.claim_type,
        claim_priority: claim.priority,
        customer_name: nameOf(names, claim.customer_id),
        claimed_amount: claim.estimated_loss,
        requested_by_name: nameOf(names, r.requested_by),
        assessment: assessment && {
          id: assessment.id,
          version_no: assessment.version_no,
          estimated_loss: assessment.estimated_loss,
          recommended_settlement: assessment.recommended_settlement,
          recommendation: assessment.recommendation,
          findings: assessment.findings,
        },
        ...approvalCapability(ctx.actor, { amount: r.amount, requestedBy: r.requested_by }),
      }
    }),
    meta: pageMeta(query, total),
  }
}

export async function decideReserve(ctx, reserveId, { decision, comments }) {
  requirePermission(ctx.actor, 'reserves.decide')
  return ctx.db.tx(async (t) => {
    const reserve = await t.findOne('reserves', { id: reserveId }, { forUpdate: true })
    if (!reserve) throw notFound('Reserve not found')
    await loadAccessibleClaim(t, ctx.actor, reserve.claim_id)
    const claim = await lockClaim(t, reserve.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (reserve.status !== 'PENDING_APPROVAL') throw businessRule('ALREADY_DECIDED', `This reserve is already ${reserve.status.toLowerCase()}`)
    if (claim.status !== 'RESERVE_APPROVAL') throw businessRule('INVALID_STAGE', 'The claim is not awaiting reserve approval')
    assertApprovalAuthority(ctx.actor, { amount: reserve.amount, requestedBy: reserve.requested_by, decision })

    const approval = await t.insert('approvals', {
      claim_id: claim.id,
      approval_type: 'RESERVE',
      reserve_id: reserve.id,
      amount: reserve.amount,
      decision,
      requested_by: reserve.requested_by,
      decided_by: ctx.actor.id,
      approver_limit: ctx.actor.approvalLimit,
      comments: comments || null,
    })
    const updatedReserve = await t.updateById('reserves', reserve.id, { status: decision, decided_at: new Date() })
    await recordAudit(t, ctx.actor, {
      action: 'RESERVE_DECIDED',
      entityType: 'reserve',
      entityId: reserve.id,
      claimId: claim.id,
      before: reserve,
      after: updatedReserve,
      metadata: { decision, comments, approvalId: approval.id },
    })

    if (reserve.assessment_id) {
      await t.updateById('assessments', reserve.assessment_id, {
        status: decision === 'APPROVED' ? 'APPROVED' : 'RETURNED',
        reviewed_by: ctx.actor.id,
        reviewed_at: new Date(),
        review_comment: comments || null,
      })
    }

    const updatedClaim =
      decision === 'APPROVED'
        ? await transitionClaim(ctx, t, claim, 'COMPLIANCE_REVIEW', { reason: `Reserve of ${reserve.amount.toFixed(2)} approved` })
        : await transitionClaim(ctx, t, claim, 'INVESTIGATION', { reason: `Reserve ${decision.toLowerCase()}: ${comments}` })

    await notify(ctx, t, {
      recipientIds: [reserve.requested_by],
      claimId: claim.id,
      type: 'APPROVAL_DECISION',
      title: `Reserve ${decision.toLowerCase()}: ${claim.claim_number}`,
      message: comments || `Reserve of ${reserve.amount.toFixed(2)} was ${decision.toLowerCase()}.`,
      link: `/claims/${claim.id}?tab=reserves`,
    })
    return { approval, reserve: updatedReserve, claim: updatedClaim }
  })
}
