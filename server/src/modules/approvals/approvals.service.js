import { ROLES } from '../../../../shared/constants.js'
import { hasAnyRole, can } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { maskAccount } from '../../utils/format.js'
import { claimScope, loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { assertApprovalAuthority, approvalCapability } from '../../services/approvalAuthority.js'

export function presentSettlement(s, actor, names = {}) {
  const { beneficiary_account: account, ...rest } = s
  return {
    ...rest,
    beneficiary_account_masked: maskAccount(account),
    requested_by_name: nameOf(names, s.requested_by),
    ...(s.status === 'PENDING_APPROVAL' ? approvalCapability(actor, { amount: s.amount, requestedBy: s.requested_by }) : {}),
  }
}

export async function listClaimSettlements(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'approvals')
  const rows = await ctx.db.findMany('settlements', { where: { claim_id: claimId }, orderBy: [['requested_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.map((r) => r.requested_by))
  return rows.map((s) => presentSettlement(s, ctx.actor, names))
}

export async function settlementQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.CLAIMS_MANAGER, ROLES.AUDITOR])) throw forbidden('Settlement queue requires manager access')
  const where = { status: 'PENDING_APPROVAL' }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('settlements', { where, orderBy: [['requested_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('settlements', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const reserves = rows.length
    ? await ctx.db.findMany('reserves', { where: { claim_id: { in: rows.map((r) => r.claim_id) }, status: 'APPROVED' } })
    : []
  const reserveMap = Object.fromEntries(reserves.map((r) => [r.claim_id, r]))
  const holds = rows.length
    ? await ctx.db.findMany('compliance_reviews', { where: { claim_id: { in: rows.map((r) => r.claim_id) }, hold_active: true }, columns: ['claim_id'] })
    : []
  const held = new Set(holds.map((h) => h.claim_id))
  const names = await profileMap(ctx.db, [...rows.map((r) => r.requested_by), ...claims.map((c) => c.customer_id)])
  return {
    items: rows.map((s) => ({
      ...presentSettlement(s, ctx.actor, names),
      claim_number: claimMap[s.claim_id]?.claim_number,
      claim_type: claimMap[s.claim_id]?.claim_type,
      claim_priority: claimMap[s.claim_id]?.priority,
      customer_name: nameOf(names, claimMap[s.claim_id]?.customer_id),
      claimed_amount: claimMap[s.claim_id]?.estimated_loss,
      approved_reserve: reserveMap[s.claim_id]?.amount ?? null,
      compliance_hold: held.has(s.claim_id),
    })),
    meta: pageMeta(query, total),
  }
}

export async function decideSettlement(ctx, settlementId, { decision, comments }) {
  requirePermission(ctx.actor, 'settlements.decide')
  return ctx.db.tx(async (t) => {
    const settlement = await t.findOne('settlements', { id: settlementId }, { forUpdate: true })
    if (!settlement) throw notFound('Settlement not found')
    await loadAccessibleClaim(t, ctx.actor, settlement.claim_id)
    const claim = await lockClaim(t, settlement.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (settlement.status !== 'PENDING_APPROVAL') throw businessRule('ALREADY_DECIDED', `This settlement is already ${settlement.status.toLowerCase()}`)
    if (claim.status !== 'SETTLEMENT_APPROVAL') throw businessRule('INVALID_STAGE', 'The claim is not awaiting settlement approval')
    assertApprovalAuthority(ctx.actor, { amount: settlement.amount, requestedBy: settlement.requested_by, decision })
    if (decision === 'APPROVED') {
      if (await hasActiveComplianceHold(t, claim.id)) {
        throw businessRule('COMPLIANCE_HOLD_ACTIVE', 'Settlement cannot be approved while a compliance hold is active')
      }
      if (!settlement.beneficiary_account) {
        throw businessRule('BENEFICIARY_DETAILS_MISSING', 'Beneficiary bank details are missing; update the policy payout details first')
      }
      const reserve = await t.findOne('reserves', { claim_id: claim.id, status: 'APPROVED' })
      if (!reserve || Number(settlement.amount) > Number(reserve.amount)) {
        throw businessRule('RESERVE_INSUFFICIENT', 'Settlement exceeds the approved reserve; the reserve must be increased first')
      }
    }

    const approval = await t.insert('approvals', {
      claim_id: claim.id,
      approval_type: 'SETTLEMENT',
      settlement_id: settlement.id,
      amount: settlement.amount,
      decision,
      requested_by: settlement.requested_by,
      decided_by: ctx.actor.id,
      approver_limit: ctx.actor.approvalLimit,
      comments: comments || null,
    })
    const updated = await t.updateById('settlements', settlement.id, { status: decision, decided_at: new Date() })
    await recordAudit(t, ctx.actor, {
      action: 'SETTLEMENT_DECIDED',
      entityType: 'settlement',
      entityId: settlement.id,
      claimId: claim.id,
      before: settlement,
      after: updated,
      metadata: { decision, comments, approvalId: approval.id },
    })

    let payment = null
    let updatedClaim
    if (decision === 'APPROVED') {
      payment = await t.insert('payments', {
        claim_id: claim.id,
        settlement_id: settlement.id,
        amount: settlement.amount,
        currency: settlement.currency,
        beneficiary_name: settlement.beneficiary_name,
        beneficiary_bank: settlement.beneficiary_bank,
        beneficiary_account: settlement.beneficiary_account,
        provider: ctx.payments.name,
        is_simulated: ctx.payments.isSimulated,
        created_by: ctx.actor.id,
      })
      await recordAudit(t, ctx.actor, { action: 'PAYMENT_REQUEST_CREATED', entityType: 'payment', entityId: payment.id, claimId: claim.id, after: payment })
      updatedClaim = await transitionClaim(ctx, t, claim, 'PAYMENT_PENDING', { reason: `Settlement of ${settlement.amount.toFixed(2)} approved` })
      await notify(ctx, t, {
        recipientIds: await userIdsWithRole(t, ROLES.PAYMENT_OPERATIONS),
        claimId: claim.id,
        type: 'APPROVAL_DECISION',
        title: `Payment ready: ${claim.claim_number}`,
        message: `Approved settlement of ${settlement.amount.toFixed(2)} is awaiting payment processing.`,
        link: '/payments',
      })
    } else {
      const latest = await t.findOne('assessments', { claim_id: claim.id, status: 'APPROVED' }, { orderBy: [['version_no', 'desc']] })
      if (latest) {
        await t.updateById('assessments', latest.id, { status: 'RETURNED', reviewed_by: ctx.actor.id, reviewed_at: new Date(), review_comment: comments })
      }
      updatedClaim = await transitionClaim(ctx, t, claim, 'INVESTIGATION', { reason: `Settlement ${decision.toLowerCase()}: ${comments}` })
    }
    await notify(ctx, t, {
      recipientIds: [settlement.requested_by],
      claimId: claim.id,
      type: 'APPROVAL_DECISION',
      title: `Settlement ${decision.toLowerCase()}: ${claim.claim_number}`,
      message: comments || `Settlement of ${settlement.amount.toFixed(2)} was ${decision.toLowerCase()}.`,
      link: `/claims/${claim.id}?tab=approvals`,
    })
    return { approval, settlement: updated, payment: payment ? { id: payment.id, status: payment.status } : null, claim: updatedClaim }
  })
}

export async function listClaimApprovals(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'approvals')
  const rows = await ctx.db.findMany('approvals', { where: { claim_id: claimId }, orderBy: [['decided_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.decided_by]))
  return rows.map((r) => ({ ...r, requested_by_name: nameOf(names, r.requested_by), decided_by_name: nameOf(names, r.decided_by) }))
}

export async function approvalHistory(ctx, query) {
  if (!can(ctx.actor.roles, 'reserves.decide') && !hasAnyRole(ctx.actor.roles, [ROLES.AUDITOR, ROLES.COMPLIANCE_OFFICER])) {
    throw forbidden('Approval history requires manager, compliance or auditor access')
  }
  const scope = await claimScope(ctx.db, ctx.actor)
  const ids = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
  const where = { claim_id: { in: ids }, approval_type: query.type, decision: query.decision }
  if (query.mine === 'true') where.decided_by = ctx.actor.id
  const [rows, total] = await Promise.all([
    ctx.db.findMany('approvals', { where, orderBy: [['decided_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('approvals', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.decided_by]))
  return {
    items: rows.map((r) => ({
      ...r,
      claim_number: claimMap[r.claim_id],
      requested_by_name: nameOf(names, r.requested_by),
      decided_by_name: nameOf(names, r.decided_by),
    })),
    meta: pageMeta(query, total),
  }
}
