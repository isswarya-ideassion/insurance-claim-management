import { ROLES, ACTIVE_RESERVE_STATUSES } from '../../../../shared/constants.js'
import { hasAnyRole, can } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { formatInr, maskLast4 } from '../../utils/format.js'
import { claimScope, loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { assertSettlementApprover, settlementStepCapability } from '../../services/authority.service.js'
import { settlementApproverRole } from '../../services/config.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

async function payeeMap(t, payments) {
  const ids = [...new Set(payments.map((p) => p.payee_id).filter(Boolean))]
  if (!ids.length) return {}
  const rows = await t.findMany('payees', { where: { id: { in: ids } }, columns: ['id', 'name', 'bank_name', 'bank_last4', 'verification_status'] })
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

async function stepsFor(t, paymentIds) {
  if (!paymentIds.length) return {}
  const rows = await t.findMany('settlement_approval_steps', { where: { payment_id: { in: paymentIds } }, orderBy: [['step_no', 'asc']] })
  const out = {}
  for (const r of rows) (out[r.payment_id] ||= []).push(r)
  return out
}

export function presentSettlement(payment, { payee, steps = [], names = {}, capability = null }) {
  return {
    ...payment,
    payee_name: payee?.name ?? null,
    payee_bank: payee?.bank_name ?? null,
    payee_account_masked: maskLast4(payee?.bank_last4),
    payee_verification: payee?.verification_status ?? null,
    requested_by_name: nameOf(names, payment.requested_by),
    approved_by_name: nameOf(names, payment.approved_by),
    steps: steps.map((s) => ({ ...s, approver_name: nameOf(names, s.approver_id) })),
    ...(capability || {}),
  }
}

/** Active reserve across all coverage lines of the claim (latest posted or approved entry per line). */
export async function activeReserveTotal(t, claimId) {
  const [row] = await t.query(
    `select coalesce(sum(amount), 0)::numeric(14,2) as total from (
       select distinct on (coverage_line) amount from public.reserves
        where claim_id = $1 and approval_status = any($2)
        order by coverage_line, effective_at desc) latest`,
    [claimId, ACTIVE_RESERVE_STATUSES],
  )
  return Number(row.total)
}

/**
 * Prepares the settlement after compliance clears a claim: a payment in
 * PENDING_APPROVAL for the evaluated amount, prepared on behalf of the
 * adjuster, with one approval step routed by settlement authority: the
 * assigned adjuster within their limit, otherwise a Claims Manager.
 */
export async function createSettlementRequest(ctx, t, claim) {
  const evaluation = await t.findOne(
    'evaluations',
    { claim_id: claim.id, status: { in: ['SUBMITTED', 'APPROVED'] } },
    { orderBy: [['version_no', 'desc']] },
  )
  if (!evaluation || evaluation.decision === 'DENY' || !(Number(evaluation.recommended_settlement) > 0)) return null
  const existing = await t.findOne('payments', { claim_id: claim.id, status: { in: ['PENDING_APPROVAL', 'PENDING', 'PROCESSING', 'FAILED'] } })
  if (existing) return existing
  const policy = claim.policy_id ? await t.findById('policies', claim.policy_id) : null
  const payment = await t.insert('payments', {
    claim_id: claim.id,
    evaluation_id: evaluation.id,
    payee_id: policy?.payee_id || null,
    amount: evaluation.recommended_settlement,
    status: 'PENDING_APPROVAL',
    provider: ctx.payments.name,
    is_simulated: ctx.payments.isSimulated,
    requested_by: evaluation.adjuster_id,
    requested_at: new Date(),
    notes: `Settlement per evaluation v${evaluation.version_no} (${evaluation.decision})`,
    created_by: ctx.actor.id,
  })
  const role = await settlementApproverRole(t, claim.segment, payment.amount)
  await t.insert('settlement_approval_steps', { payment_id: payment.id, step_no: 1, required_role: role, status: 'PENDING' })
  await recordAudit(t, ctx.actor, { action: 'SETTLEMENT_REQUESTED', entityType: 'payment', entityId: payment.id, claimId: claim.id, after: payment, metadata: { approverRole: role } })
  await notify(ctx, t, {
    recipientIds: role === ROLES.ADJUSTER ? [claim.assigned_adjuster_id].filter(Boolean) : await userIdsWithRole(t, role),
    claimId: claim.id,
    type: 'APPROVAL_REQUIRED',
    title: `Settlement approval required: ${claim.claim_number}`,
    message: `Settlement of ${formatInr(payment.amount)} awaits approval.`,
    link: `/claims/${claim.id}?tab=approvals`,
  })
  return payment
}

export async function listClaimSettlements(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'approvals')
  const rows = await ctx.db.findMany('payments', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const [payees, steps] = await Promise.all([payeeMap(ctx.db, rows), stepsFor(ctx.db, rows.map((r) => r.id))])
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.approved_by, ...(steps[r.id] || []).map((s) => s.approver_id)]))
  const out = []
  for (const p of rows) {
    const pending = (steps[p.id] || []).find((s) => s.status === 'PENDING')
    const capability = p.status === 'PENDING_APPROVAL' ? await settlementStepCapability(ctx.db, ctx.actor, p, pending, claim) : null
    out.push(presentSettlement(p, { payee: payees[p.payee_id], steps: steps[p.id], names, capability }))
  }
  return out
}

export async function settlementQueue(ctx, query) {
  if (!hasAnyRole(ctx.actor.roles, [ROLES.ADJUSTER, ROLES.OPS_MANAGER, ROLES.COMPLIANCE_SECURITY])) {
    throw forbidden('The settlement queue requires Adjuster or Claims Manager access')
  }
  const where = { status: 'PENDING_APPROVAL' }
  // Adjusters see settlements on the claims currently assigned to them.
  if (!hasAnyRole(ctx.actor.roles, [ROLES.OPS_MANAGER, ROLES.COMPLIANCE_SECURITY])) {
    const mine = await ctx.db.findMany('claims', { where: { assigned_adjuster_id: ctx.actor.id }, columns: ['id'] })
    where.claim_id = { in: mine.map((c) => c.id) }
  }
  if (query.awaitingMe === 'true') {
    const pending = await ctx.db.findMany('settlement_approval_steps', {
      where: { status: 'PENDING', required_role: { in: ctx.actor.roles } },
      columns: ['payment_id'],
    })
    where.id = { in: pending.map((s) => s.payment_id) }
  }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('payments', { where, orderBy: [['requested_at', 'asc']], ...toOffset(query) }),
    ctx.db.count('payments', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } } }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const [payees, steps] = await Promise.all([payeeMap(ctx.db, rows), stepsFor(ctx.db, rows.map((r) => r.id))])
  const names = await profileMap(ctx.db, [...rows.map((r) => r.requested_by), ...claims.map((c) => c.customer_id)])
  const items = []
  for (const p of rows) {
    const claim = claimMap[p.claim_id] || {}
    const pending = (steps[p.id] || []).find((s) => s.status === 'PENDING')
    items.push({
      ...presentSettlement(p, { payee: payees[p.payee_id], steps: steps[p.id], names, capability: await settlementStepCapability(ctx.db, ctx.actor, p, pending, claim) }),
      required_role: pending?.required_role ?? null,
      claim_number: claim.claim_number,
      claim_type: claim.claim_type,
      claim_priority: claim.priority,
      claim_segment: claim.segment,
      customer_name: nameOf(names, claim.customer_id),
      claimed_amount: claim.estimated_loss,
      approved_reserve: await activeReserveTotal(ctx.db, p.claim_id),
      compliance_hold: await hasActiveComplianceHold(ctx.db, p.claim_id),
    })
  }
  return { items, meta: pageMeta(query, total) }
}

export async function decideSettlement(ctx, paymentId, { decision, comments }) {
  requirePermission(ctx.actor, 'settlements.approve')
  return ctx.db.tx(async (t) => {
    const payment = await t.findOne('payments', { id: paymentId }, { forUpdate: true })
    if (!payment) throw notFound('Settlement not found')
    await loadAccessibleClaim(t, ctx.actor, payment.claim_id)
    const claim = await lockClaim(t, payment.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (payment.status !== 'PENDING_APPROVAL') throw businessRule('ALREADY_DECIDED', `This settlement is already ${payment.status.toLowerCase().replace('_', ' ')}`)
    if (claim.status !== 'SETTLEMENT_APPROVAL') throw businessRule('INVALID_STAGE', 'The claim is not awaiting settlement approval')
    const step = await t.findOne('settlement_approval_steps', { payment_id: paymentId, status: 'PENDING' }, { orderBy: [['step_no', 'asc']], forUpdate: true })
    if (!step) throw businessRule('NO_PENDING_STEP', 'This settlement has no pending approval step')
    await assertSettlementApprover(t, ctx.actor, payment, step, claim, decision)

    if (decision === 'APPROVED') {
      if (await hasActiveComplianceHold(t, claim.id)) {
        throw businessRule('COMPLIANCE_HOLD_ACTIVE', 'Settlement cannot be approved while a compliance hold is active')
      }
      const payee = payment.payee_id ? await t.findById('payees', payment.payee_id) : null
      if (!payee?.bank_details_encrypted) {
        throw businessRule('BENEFICIARY_DETAILS_MISSING', 'Payee bank details are missing; a Payment Operator must record them first')
      }
      if (Number(payment.amount) > (await activeReserveTotal(t, claim.id))) {
        throw businessRule('RESERVE_INSUFFICIENT', 'Settlement exceeds the active reserve; the reserve must be increased first')
      }
    }

    const decided = await t.updateById('settlement_approval_steps', step.id, {
      status: decision,
      approver_id: ctx.actor.id,
      decided_at: new Date(),
      comment: comments || null,
    })
    const updated = await t.updateById('payments', payment.id, {
      status: decision === 'APPROVED' ? 'PENDING' : decision,
      approved_by: decision === 'APPROVED' ? ctx.actor.id : null,
      approved_at: decision === 'APPROVED' ? new Date() : null,
      updated_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: 'SETTLEMENT_DECIDED',
      entityType: 'payment',
      entityId: payment.id,
      claimId: claim.id,
      before: payment,
      after: updated,
      metadata: { decision, comments, stepNo: step.step_no, requiredRole: step.required_role, approverLimit: decided.approver_limit_at_decision },
    })

    let updatedClaim
    if (decision === 'APPROVED') {
      updatedClaim = await transitionClaim(ctx, t, claim, 'PAYMENT_PENDING', { reason: `Settlement of ${formatInr(payment.amount)} approved` })
      // Separation of duties: the approver cannot issue, so they are not asked to.
      await notify(ctx, t, {
        recipientIds: (await userIdsWithRole(t, ROLES.PAYMENT_OPERATOR)).filter((u) => u !== ctx.actor.id),
        claimId: claim.id,
        type: 'APPROVAL_DECISION',
        title: `Payment ready: ${claim.claim_number}`,
        message: `Approved settlement of ${formatInr(payment.amount)} is awaiting issuance.`,
        link: '/payments',
      })
    } else {
      const latest = await t.findOne('evaluations', { claim_id: claim.id, status: { in: ['SUBMITTED', 'APPROVED'] } }, { orderBy: [['version_no', 'desc']] })
      if (latest) {
        await t.updateById('evaluations', latest.id, { status: 'RETURNED', reviewed_by: ctx.actor.id, reviewed_at: new Date(), review_comment: comments })
      }
      updatedClaim = await transitionClaim(ctx, t, claim, 'INVESTIGATION', { reason: `Settlement ${decision.toLowerCase()}: ${comments}` })
    }
    if (payment.requested_by) {
      await notify(ctx, t, {
        recipientIds: [payment.requested_by],
        claimId: claim.id,
        type: decision === 'REJECTED' ? 'APPROVAL_REJECTED' : 'APPROVAL_DECISION',
        title: `Settlement ${decision.toLowerCase()}: ${claim.claim_number}`,
        message: comments || `Settlement of ${formatInr(payment.amount)} was ${decision.toLowerCase()}.`,
        link: `/claims/${claim.id}?tab=approvals`,
      })
    }
    return { step: decided, settlement: updated, claim: updatedClaim }
  })
}

// ---------------------------------------------------------------------------
// Decision history: reverse reviews (reserve, evaluation, closure) and settlement steps
// ---------------------------------------------------------------------------
async function decisionRows(t, claimIds, filters = {}) {
  if (!claimIds.length) return []
  const rows = []
  if (!filters.type || filters.type !== 'SETTLEMENT') {
    const reviews = await t.findMany('reviews', {
      where: { claim_id: { in: claimIds }, checkpoint_type: filters.type ? filters.type : { ne: 'COMPLIANCE' }, outcome: filters.decision },
    })
    for (const r of reviews) {
      rows.push({
        id: r.id,
        claim_id: r.claim_id,
        approval_type: r.checkpoint_type,
        decision: r.outcome,
        amount: r.amount,
        approver_limit: r.approver_limit,
        requested_by: r.requested_by,
        decided_by: r.decided_by,
        comments: r.comments,
        decided_at: r.reviewed_at,
      })
    }
  }
  if (!filters.type || filters.type === 'SETTLEMENT') {
    const steps = await t.query(
      `select s.*, p.claim_id, p.amount, p.requested_by from public.settlement_approval_steps s
         join public.payments p on p.id = s.payment_id
        where p.claim_id = any($1) and s.status <> 'PENDING' and ($2::text is null or s.status = $2)`,
      [claimIds, filters.decision || null],
    )
    for (const s of steps) {
      rows.push({
        id: s.id,
        claim_id: s.claim_id,
        approval_type: 'SETTLEMENT',
        decision: s.status,
        amount: s.amount,
        approver_limit: s.approver_limit_at_decision,
        required_role: s.required_role,
        requested_by: s.requested_by,
        decided_by: s.approver_id,
        comments: s.comment,
        decided_at: s.decided_at,
      })
    }
  }
  return rows.sort((a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime())
}

export async function listClaimApprovals(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'approvals')
  const rows = await decisionRows(ctx.db, [claimId])
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.decided_by]))
  return rows.map((r) => ({ ...r, requested_by_name: nameOf(names, r.requested_by), decided_by_name: nameOf(names, r.decided_by) }))
}

export async function approvalHistory(ctx, query) {
  if (!can(ctx.actor.roles, 'reserves.review') && !can(ctx.actor.roles, 'settlements.approve') && !ctx.actor.roles.includes(ROLES.COMPLIANCE_SECURITY)) {
    throw forbidden('Decision history requires Claims Manager, Payment Operator or Compliance access')
  }
  const scope = await claimScope(ctx.db, ctx.actor)
  const ids = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
  let rows = await decisionRows(ctx.db, ids, { type: query.type, decision: query.decision })
  if (query.mine === 'true') rows = rows.filter((r) => r.decided_by === ctx.actor.id)
  const total = rows.length
  const { limit, offset } = toOffset(query)
  const page = rows.slice(offset, offset + limit)
  const claims = page.length ? await ctx.db.findMany('claims', { where: { id: { in: page.map((r) => r.claim_id) } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  const names = await profileMap(ctx.db, page.flatMap((r) => [r.requested_by, r.decided_by]))
  return {
    items: page.map((r) => ({
      ...r,
      claim_number: claimMap[r.claim_id],
      requested_by_name: nameOf(names, r.requested_by),
      decided_by_name: nameOf(names, r.decided_by),
    })),
    meta: pageMeta(query, total),
  }
}
