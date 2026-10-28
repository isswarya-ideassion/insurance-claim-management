import { ROLES } from '../../../../shared/constants.js'
import { can } from '../../../../shared/permissions.js'
import { businessRule, conflict, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { maskAccount } from '../../utils/format.js'
import { escapeLike } from '../../db/queryBuilder.js'
import {
  claimScope,
  isCustomerView,
  loadAccessibleClaim,
  requirePermission,
  requireNotOwnClaim,
  requireTab,
} from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

export function presentPayment(p) {
  const { beneficiary_account: account, ...rest } = p
  return { ...rest, beneficiary_account_masked: maskAccount(account) }
}

const CUSTOMER_PAYMENT_LABELS = {
  PENDING: 'Scheduled',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Delayed',
  RECONCILED: 'Paid',
  CANCELLED: 'Cancelled',
}

async function loadPaymentForStaff(t, ctx, id, { forUpdate = false } = {}) {
  const payment = await t.findOne('payments', { id }, { forUpdate })
  if (!payment) throw notFound('Payment not found')
  const claim = await loadAccessibleClaim(t, ctx.actor, payment.claim_id)
  requireTab(ctx.actor, claim, 'payments')
  return { payment, claim }
}

export async function listPayments(ctx, query) {
  requirePermission(ctx.actor, 'payments.view')
  const scope = await claimScope(ctx.db, ctx.actor)
  const claimWhere = { $and: [scope, { status: { ne: 'DRAFT' } }] }
  if (query.search) claimWhere.$and.push({ claim_number: { ilike: `%${escapeLike(query.search)}%` } })
  const claimIds = (await ctx.db.findMany('claims', { where: claimWhere, columns: ['id'] })).map((c) => c.id)
  const where = { claim_id: { in: claimIds } }
  if (query.status?.length) where.status = { in: query.status }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('payments', { where, orderBy: [['updated_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('payments', where),
  ])
  const claims = rows.length
    ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } }, columns: ['id', 'claim_number', 'status', 'customer_id'] })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const holds = rows.length
    ? await ctx.db.findMany('compliance_reviews', { where: { claim_id: { in: rows.map((r) => r.claim_id) }, hold_active: true }, columns: ['claim_id'] })
    : []
  const held = new Set(holds.map((h) => h.claim_id))
  const names = await profileMap(ctx.db, claims.map((c) => c.customer_id))
  return {
    items: rows.map((p) => ({
      ...presentPayment(p),
      claim_number: claimMap[p.claim_id]?.claim_number,
      claim_status: claimMap[p.claim_id]?.status,
      customer_name: nameOf(names, claimMap[p.claim_id]?.customer_id),
      compliance_hold: held.has(p.claim_id),
    })),
    meta: pageMeta(query, total),
  }
}

export async function getPayment(ctx, id) {
  requirePermission(ctx.actor, 'payments.view')
  const { payment, claim } = await loadPaymentForStaff(ctx.db, ctx, id)
  const [attempts, settlement, approvals] = await Promise.all([
    ctx.db.findMany('payment_attempts', { where: { payment_id: id }, orderBy: [['attempt_no', 'desc']] }),
    ctx.db.findById('settlements', payment.settlement_id),
    ctx.db.findMany('approvals', { where: { settlement_id: payment.settlement_id }, orderBy: [['decided_at', 'desc']] }),
  ])
  const names = await profileMap(ctx.db, [
    ...attempts.map((a) => a.initiated_by),
    payment.reconciled_by,
    claim.customer_id,
    ...approvals.map((a) => a.decided_by),
  ])
  return {
    payment: { ...presentPayment(payment), reconciled_by_name: nameOf(names, payment.reconciled_by) },
    attempts: attempts.map((a) => ({ ...a, initiated_by_name: nameOf(names, a.initiated_by) })),
    settlement: settlement && { id: settlement.id, amount: settlement.amount, status: settlement.status, decided_at: settlement.decided_at },
    approval: approvals[0] ? { ...approvals[0], decided_by_name: nameOf(names, approvals[0].decided_by) } : null,
    claim: { id: claim.id, claim_number: claim.claim_number, status: claim.status, customer_name: nameOf(names, claim.customer_id) },
    complianceHold: await hasActiveComplianceHold(ctx.db, claim.id),
    canViewBeneficiary: can(ctx.actor.roles, 'payments.viewBeneficiary'),
  }
}

export async function listClaimPayments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'payments')
  const payments = await ctx.db.findMany('payments', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const attempts = payments.length
    ? await ctx.db.findMany('payment_attempts', { where: { payment_id: { in: payments.map((p) => p.id) } }, orderBy: [['attempt_no', 'desc']] })
    : []
  const names = await profileMap(ctx.db, attempts.map((a) => a.initiated_by))
  return payments.map((p) => ({
    ...presentPayment(p),
    attempts: attempts.filter((a) => a.payment_id === p.id).map((a) => ({ ...a, initiated_by_name: nameOf(names, a.initiated_by) })),
  }))
}

/** Customer-safe settlement and payment status for one claim. */
export async function claimPaymentStatus(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  if (!isCustomerView(ctx.actor, claim)) requireTab(ctx.actor, claim, 'payments')
  const settlement = await ctx.db.findOne('settlements', { claim_id: claimId, status: 'APPROVED' }, { orderBy: [['decided_at', 'desc']] })
  const payment = settlement ? await ctx.db.findOne('payments', { settlement_id: settlement.id }) : null
  return {
    claimId,
    claimNumber: claim.claim_number,
    settlement: settlement ? { amount: settlement.amount, currency: settlement.currency, approvedAt: settlement.decided_at } : null,
    payment: payment
      ? {
          status: payment.status,
          statusLabel: CUSTOMER_PAYMENT_LABELS[payment.status],
          amount: payment.amount,
          currency: payment.currency,
          paidAt: payment.paid_at,
          beneficiaryAccount: maskAccount(payment.beneficiary_account),
          reference: payment.transaction_reference,
          isSimulated: payment.is_simulated,
        }
      : null,
  }
}

export async function myPayments(ctx) {
  const claims = await ctx.db.findMany('claims', {
    where: { customer_id: ctx.actor.id, status: { nin: ['DRAFT'] } },
    orderBy: [['submitted_at', 'desc']],
    columns: ['id'],
  })
  const out = []
  for (const c of claims) out.push(await claimPaymentStatus(ctx, c.id))
  const claimRows = await ctx.db.findMany('claims', { where: { id: { in: claims.map((c) => c.id) } }, columns: ['id', 'status', 'claim_type'] })
  const statusMap = Object.fromEntries(claimRows.map((c) => [c.id, c]))
  return out.map((o) => ({ ...o, claimType: statusMap[o.claimId]?.claim_type, claimStatus: statusMap[o.claimId]?.status }))
}

export async function revealBeneficiary(ctx, id) {
  requirePermission(ctx.actor, 'payments.viewBeneficiary')
  const { payment, claim } = await loadPaymentForStaff(ctx.db, ctx, id)
  requireNotOwnClaim(ctx.actor, claim)
  await recordAudit(ctx.db, ctx.actor, {
    action: 'BENEFICIARY_DETAILS_VIEWED',
    entityType: 'payment',
    entityId: id,
    claimId: payment.claim_id,
  })
  return { beneficiaryName: payment.beneficiary_name, beneficiaryBank: payment.beneficiary_bank, beneficiaryAccount: payment.beneficiary_account }
}

export async function processPayment(ctx, id, idempotencyKey) {
  requirePermission(ctx.actor, 'payments.process')

  const prior = await ctx.db.findOne('payment_attempts', { idempotency_key: idempotencyKey })
  if (prior) {
    if (prior.payment_id !== id) throw conflict('This Idempotency-Key was already used for a different payment', 'IDEMPOTENCY_KEY_REUSED')
    const payment = await ctx.db.findById('payments', id)
    return { replayed: true, attempt: prior, payment: presentPayment(payment) }
  }

  // Phase 1: lock, validate, and move PENDING -> PROCESSING (compare-and-set).
  const { payment, attempt } = await ctx.db.tx(async (t) => {
    const { payment: current } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    const claim = await lockClaim(t, current.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (current.status !== 'PENDING') {
      throw conflict(
        current.status === 'PROCESSING' ? 'This payment is already being processed' : `Payment is ${current.status.toLowerCase()} and cannot be processed`,
        'PAYMENT_NOT_PENDING',
        { status: current.status },
      )
    }
    if (claim.status !== 'PAYMENT_PENDING') throw businessRule('INVALID_STAGE', 'The claim is not awaiting payment')
    const settlement = await t.findById('settlements', current.settlement_id)
    if (settlement?.status !== 'APPROVED') throw businessRule('SETTLEMENT_NOT_APPROVED', 'Payment requires an approved settlement')
    if (await hasActiveComplianceHold(t, claim.id)) {
      throw businessRule('COMPLIANCE_HOLD_ACTIVE', 'Payment is blocked by an active compliance hold')
    }

    const [locked] = await t.update('payments', { id, status: 'PENDING' }, { status: 'PROCESSING', attempt_count: current.attempt_count + 1 })
    if (!locked) throw conflict('This payment is already being processed', 'PAYMENT_NOT_PENDING')
    const newAttempt = await t.insert('payment_attempts', {
      payment_id: id,
      attempt_no: current.attempt_count + 1,
      idempotency_key: idempotencyKey,
      provider: ctx.payments.name,
      initiated_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: 'PAYMENT_PROCESSING_STARTED',
      entityType: 'payment',
      entityId: id,
      claimId: claim.id,
      metadata: { attemptNo: newAttempt.attempt_no, provider: ctx.payments.name, simulated: ctx.payments.isSimulated },
    })
    return { payment: locked, attempt: newAttempt }
  })

  // Phase 2: call the adapter outside any transaction.
  let result
  try {
    result = await ctx.payments.initiateTransfer({
      paymentId: id,
      amount: payment.amount,
      currency: payment.currency,
      beneficiaryName: payment.beneficiary_name,
      beneficiaryAccount: payment.beneficiary_account,
      idempotencyKey,
    })
  } catch (err) {
    result = { status: 'FAILED', failureCode: 'ADAPTER_ERROR', failureReason: `Payment adapter error: ${err.message}`, provider: ctx.payments.name }
  }

  // Phase 3: record the outcome and advance the claim.
  return ctx.db.tx(async (t) => {
    const succeeded = result.status === 'SUCCEEDED'
    const finishedAttempt = await t.updateById('payment_attempts', attempt.id, {
      status: succeeded ? 'SUCCEEDED' : 'FAILED',
      provider_reference: result.providerReference || null,
      failure_code: result.failureCode || null,
      failure_reason: result.failureReason || null,
      completed_at: new Date(),
      raw_response: result,
    })
    const updated = await t.updateById(
      'payments',
      id,
      succeeded
        ? { status: 'PAID', transaction_reference: result.providerReference, paid_at: new Date(), last_failure_reason: null }
        : { status: 'FAILED', last_failure_reason: result.failureReason },
    )
    const claim = await lockClaim(t, payment.claim_id)
    await transitionClaim(ctx, t, claim, succeeded ? 'PAID' : 'PAYMENT_FAILED', {
      system: true,
      reason: succeeded ? `Payment ${result.providerReference} completed` : result.failureReason,
    })
    await recordAudit(t, ctx.actor, {
      action: succeeded ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_FAILED',
      entityType: 'payment',
      entityId: id,
      claimId: claim.id,
      before: payment,
      after: updated,
      metadata: { attemptNo: attempt.attempt_no, reference: result.providerReference, failureCode: result.failureCode, simulated: ctx.payments.isSimulated },
    })
    if (!succeeded) {
      await notify(ctx, t, {
        recipientIds: (await userIdsWithRole(t, ROLES.PAYMENT_OPERATIONS)).filter((u) => u !== ctx.actor.id),
        claimId: claim.id,
        type: 'PAYMENT_FAILED',
        title: `Payment failed: ${claim.claim_number}`,
        message: result.failureReason,
        link: `/payments/${id}`,
        email: false,
      })
    }
    return { replayed: false, attempt: finishedAttempt, payment: presentPayment(updated) }
  })
}

export async function retryPayment(ctx, id, { reason }) {
  requirePermission(ctx.actor, 'payments.process')
  return ctx.db.tx(async (t) => {
    const { payment } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    const claim = await lockClaim(t, payment.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (payment.status !== 'FAILED') throw businessRule('PAYMENT_NOT_FAILED', 'Only failed payments can be retried')
    const updated = await t.updateById('payments', id, { status: 'PENDING' })
    await transitionClaim(ctx, t, claim, 'PAYMENT_PENDING', { reason: reason || 'Payment queued for retry' })
    await recordAudit(t, ctx.actor, { action: 'PAYMENT_RETRY_QUEUED', entityType: 'payment', entityId: id, claimId: claim.id, before: payment, after: updated, metadata: { reason } })
    return presentPayment(updated)
  })
}

export async function updateBeneficiary(ctx, id, input) {
  requirePermission(ctx.actor, 'payments.process')
  return ctx.db.tx(async (t) => {
    const { payment, claim } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    requireNotOwnClaim(ctx.actor, claim)
    if (!['FAILED', 'PENDING'].includes(payment.status)) {
      throw businessRule('PAYMENT_LOCKED', 'Beneficiary details can only change before payment or after a failure')
    }
    const updated = await t.updateById('payments', id, {
      beneficiary_name: input.beneficiaryName,
      beneficiary_bank: input.beneficiaryBank || null,
      beneficiary_account: input.beneficiaryAccount,
    })
    await recordAudit(t, ctx.actor, {
      action: 'BENEFICIARY_UPDATED',
      entityType: 'payment',
      entityId: id,
      claimId: claim.id,
      before: payment,
      after: updated,
      metadata: { reason: input.reason, newAccount: maskAccount(input.beneficiaryAccount) },
    })
    return presentPayment(updated)
  })
}

export async function reconcilePayment(ctx, id, { reconciliationReference, notes }) {
  requirePermission(ctx.actor, 'payments.reconcile')
  return ctx.db.tx(async (t) => {
    const { payment, claim } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    requireNotOwnClaim(ctx.actor, claim)
    if (payment.status !== 'PAID') throw businessRule('PAYMENT_NOT_PAID', 'Only paid payments can be reconciled')
    const updated = await t.updateById('payments', id, {
      status: 'RECONCILED',
      reconciled_at: new Date(),
      reconciled_by: ctx.actor.id,
      reconciliation_reference: reconciliationReference,
    })
    await recordAudit(t, ctx.actor, { action: 'PAYMENT_RECONCILED', entityType: 'payment', entityId: id, claimId: claim.id, before: payment, after: updated, metadata: { notes } })
    return presentPayment(updated)
  })
}

export async function reconciliationSummary(ctx) {
  requirePermission(ctx.actor, 'payments.view')
  const byStatus = await ctx.db.query(
    `select status, count(*)::int as count, coalesce(sum(amount), 0)::numeric(14,2) as total from public.payments group by status`,
  )
  const attempts = await ctx.db.query(`select status, count(*)::int as count from public.payment_attempts group by status`)
  const unreconciled = await ctx.db.findMany('payments', { where: { status: 'PAID' }, orderBy: [['paid_at', 'asc']], limit: 50 })
  const stuck = await ctx.db.findMany('payments', {
    where: { status: 'PROCESSING', updated_at: { lt: new Date(Date.now() - 15 * 60_000) } },
    limit: 50,
  })
  const failureReasons = await ctx.db.query(
    `select coalesce(failure_code, 'UNKNOWN') as code, count(*)::int as count from public.payment_attempts where status = 'FAILED' group by failure_code order by count desc`,
  )
  const claimIds = [...unreconciled, ...stuck].map((p) => p.claim_id)
  const claims = claimIds.length ? await ctx.db.findMany('claims', { where: { id: { in: claimIds } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  const succeeded = attempts.find((a) => a.status === 'SUCCEEDED')?.count || 0
  const failed = attempts.find((a) => a.status === 'FAILED')?.count || 0
  return {
    simulated: ctx.payments.isSimulated,
    byStatus,
    attempts: { succeeded, failed, total: succeeded + failed, successRate: succeeded + failed ? succeeded / (succeeded + failed) : null },
    failureReasons,
    unreconciled: unreconciled.map((p) => ({ ...presentPayment(p), claim_number: claimMap[p.claim_id] })),
    stuckProcessing: stuck.map((p) => ({ ...presentPayment(p), claim_number: claimMap[p.claim_id] })),
  }
}
