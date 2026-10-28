import { ROLES, ACTIVE_RESERVE_STATUSES, defaultCoverageLine } from '../../../../shared/constants.js'
import { can } from '../../../../shared/permissions.js'
import { businessRule, conflict, forbidden, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { formatInr, maskLast4 } from '../../utils/format.js'
import { escapeLike } from '../../db/queryBuilder.js'
import {
  claimScope,
  isCustomerView,
  loadAccessibleClaim,
  requirePermission,
  requireNotOwnClaim,
  requireStaffView,
  requireTab,
} from '../../services/access.service.js'
import { hasActiveComplianceHold, lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const CUSTOMER_PAYMENT_LABELS = {
  PENDING: 'Scheduled',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  FAILED: 'Delayed',
  RECONCILED: 'Paid',
  CANCELLED: 'Cancelled',
}

/** Payment for display; bank details are only ever shown as the last four digits. */
export function presentPayment(p, payee = null) {
  return {
    ...p,
    payee_name: payee?.name ?? null,
    payee_bank: payee?.bank_name ?? null,
    payee_account_masked: maskLast4(payee?.bank_last4),
    payee_verification: payee?.verification_status ?? null,
  }
}

async function payeeMap(t, payments) {
  const ids = [...new Set(payments.map((p) => p.payee_id).filter(Boolean))]
  if (!ids.length) return {}
  const rows = await t.findMany('payees', { where: { id: { in: ids } } })
  return Object.fromEntries(rows.map((r) => [r.id, r]))
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
  const held = new Set(
    rows.length
      ? (await ctx.db.findMany('reviews', { where: { claim_id: { in: rows.map((r) => r.claim_id) }, checkpoint_type: 'COMPLIANCE', hold_active: true }, columns: ['claim_id'] })).map((h) => h.claim_id)
      : [],
  )
  const blocks = rows.length
    ? await ctx.db.query(`select payment_id, count(*)::int as count from public.payment_blocks where payment_id = any($1) and resolved_at is null group by payment_id`, [rows.map((r) => r.id)])
    : []
  const blockMap = Object.fromEntries(blocks.map((b) => [b.payment_id, b.count]))
  const [payees, names] = await Promise.all([payeeMap(ctx.db, rows), profileMap(ctx.db, claims.map((c) => c.customer_id))])
  return {
    items: rows.map((p) => ({
      ...presentPayment(p, payees[p.payee_id]),
      claim_number: claimMap[p.claim_id]?.claim_number,
      claim_status: claimMap[p.claim_id]?.status,
      customer_name: nameOf(names, claimMap[p.claim_id]?.customer_id),
      compliance_hold: held.has(p.claim_id),
      open_blocks: blockMap[p.id] || 0,
    })),
    meta: pageMeta(query, total),
  }
}

export async function getPayment(ctx, id) {
  requirePermission(ctx.actor, 'payments.view')
  const { payment, claim } = await loadPaymentForStaff(ctx.db, ctx, id)
  const [attempts, steps, blocks, payee] = await Promise.all([
    ctx.db.findMany('payment_attempts', { where: { payment_id: id }, orderBy: [['attempt_no', 'desc']] }),
    ctx.db.findMany('settlement_approval_steps', { where: { payment_id: id }, orderBy: [['step_no', 'asc']] }),
    ctx.db.findMany('payment_blocks', { where: { payment_id: id }, orderBy: [['opened_at', 'desc']] }),
    payment.payee_id ? ctx.db.findById('payees', payment.payee_id) : null,
  ])
  const duplicates = payee?.bank_details_hash
    ? await ctx.db.findMany('payees', { where: { bank_details_hash: payee.bank_details_hash, id: { ne: payee.id } }, columns: ['id', 'name'] })
    : []
  const names = await profileMap(ctx.db, [
    ...attempts.map((a) => a.initiated_by),
    ...steps.map((s) => s.approver_id),
    ...blocks.flatMap((b) => [b.opened_by, b.resolved_by]),
    payment.reconciled_by,
    payment.requested_by,
    claim.customer_id,
    payee?.verified_by,
    payee?.bank_details_changed_by,
  ])
  const approvedStep = steps.filter((s) => s.status === 'APPROVED').pop()
  return {
    payment: { ...presentPayment(payment, payee), reconciled_by_name: nameOf(names, payment.reconciled_by), requested_by_name: nameOf(names, payment.requested_by) },
    payee: payee && {
      id: payee.id,
      name: payee.name,
      bank_name: payee.bank_name,
      account_masked: maskLast4(payee.bank_last4),
      verification_status: payee.verification_status,
      verified_at: payee.verified_at,
      verified_by_name: nameOf(names, payee.verified_by),
      bank_details_changed_at: payee.bank_details_changed_at,
      bank_details_changed_by: payee.bank_details_changed_by,
      bank_details_changed_by_name: nameOf(names, payee.bank_details_changed_by),
      duplicate_payees: duplicates,
    },
    attempts: attempts.map((a) => ({ ...a, initiated_by_name: nameOf(names, a.initiated_by) })),
    steps: steps.map((s) => ({ ...s, approver_name: nameOf(names, s.approver_id) })),
    approval: approvedStep ? { ...approvedStep, decided_by: approvedStep.approver_id, decided_by_name: nameOf(names, approvedStep.approver_id) } : null,
    blocks: blocks.map((b) => ({ ...b, opened_by_name: nameOf(names, b.opened_by), resolved_by_name: nameOf(names, b.resolved_by) })),
    claim: { id: claim.id, claim_number: claim.claim_number, status: claim.status, customer_name: nameOf(names, claim.customer_id) },
    complianceHold: await hasActiveComplianceHold(ctx.db, claim.id),
    canViewBeneficiary: can(ctx.actor.roles, 'payments.viewBeneficiary'),
    canIssue: can(ctx.actor.roles, 'payments.issue') && !steps.some((s) => s.status === 'APPROVED' && s.approver_id === ctx.actor.id),
  }
}

export async function listClaimPayments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'payments')
  const payments = await ctx.db.findMany('payments', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const attempts = payments.length
    ? await ctx.db.findMany('payment_attempts', { where: { payment_id: { in: payments.map((p) => p.id) } }, orderBy: [['attempt_no', 'desc']] })
    : []
  const [payees, names] = await Promise.all([payeeMap(ctx.db, payments), profileMap(ctx.db, attempts.map((a) => a.initiated_by))])
  return payments.map((p) => ({
    ...presentPayment(p, payees[p.payee_id]),
    attempts: attempts.filter((a) => a.payment_id === p.id).map((a) => ({ ...a, initiated_by_name: nameOf(names, a.initiated_by) })),
  }))
}

/** Client-safe settlement and payment status for one claim. */
export async function claimPaymentStatus(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  if (!isCustomerView(ctx.actor, claim)) requireTab(ctx.actor, claim, 'payments')
  const payment = await ctx.db.findOne(
    'payments',
    { claim_id: claimId, status: { in: ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED'] } },
    { orderBy: [['approved_at', 'desc']] },
  )
  const payee = payment?.payee_id ? await ctx.db.findById('payees', payment.payee_id) : null
  return {
    claimId,
    claimNumber: claim.claim_number,
    settlement: payment ? { amount: payment.amount, currency: payment.currency, approvedAt: payment.approved_at } : null,
    payment: payment
      ? {
          status: payment.status,
          statusLabel: CUSTOMER_PAYMENT_LABELS[payment.status],
          amount: payment.amount,
          currency: payment.currency,
          paidAt: payment.issued_at,
          beneficiaryAccount: maskLast4(payee?.bank_last4),
          reference: payment.portal_reference,
          isSimulated: payment.is_simulated,
        }
      : null,
  }
}

export async function myPayments(ctx) {
  const claims = await ctx.db.findMany('claims', {
    where: { customer_id: ctx.actor.id, status: { nin: ['DRAFT'] } },
    orderBy: [['opened_at', 'desc']],
    columns: ['id', 'status', 'claim_type'],
  })
  const out = []
  for (const c of claims) out.push({ ...(await claimPaymentStatus(ctx, c.id)), claimType: c.claim_type, claimStatus: c.status })
  return out
}

/** Reveals the full payee bank account to a Payment Operator; every reveal is audited. */
export async function revealBeneficiary(ctx, id) {
  requirePermission(ctx.actor, 'payments.viewBeneficiary')
  const { payment, claim } = await loadPaymentForStaff(ctx.db, ctx, id)
  requireNotOwnClaim(ctx.actor, claim)
  const payee = payment.payee_id ? await ctx.db.findById('payees', payment.payee_id) : null
  if (!payee) throw notFound('This settlement has no payee')
  await recordAudit(ctx.db, ctx.actor, {
    action: 'BENEFICIARY_DETAILS_VIEWED',
    entityType: 'payee',
    entityId: payee.id,
    claimId: payment.claim_id,
    metadata: { paymentId: id },
  })
  return { beneficiaryName: payee.name, beneficiaryBank: payee.bank_name, beneficiaryAccount: ctx.crypto.decrypt(payee.bank_details_encrypted) }
}

/** Reduces the reserve ledger by the issued amount, default coverage line first. */
async function reduceReserves(t, claim, paidAmount, actorId) {
  const active = await t.query(
    `select distinct on (coverage_line) * from public.reserves
      where claim_id = $1 and approval_status = any($2)
      order by coverage_line, effective_at desc`,
    [claim.id, ACTIVE_RESERVE_STATUSES],
  )
  const primary = defaultCoverageLine(claim.claim_type)
  active.sort((a, b) => (a.coverage_line === primary ? -1 : b.coverage_line === primary ? 1 : 0))
  let remaining = Number(paidAmount)
  for (const r of active) {
    if (remaining <= 0) break
    const reduce = Math.min(remaining, Number(r.amount))
    if (reduce <= 0) continue
    remaining -= reduce
    await t.updateById('reserves', r.id, { approval_status: 'SUPERSEDED' })
    await t.insert('reserves', {
      claim_id: claim.id,
      evaluation_id: r.evaluation_id,
      coverage_line: r.coverage_line,
      amount: Math.round((Number(r.amount) - reduce) * 100) / 100,
      prev_amount: r.amount,
      currency: r.currency,
      reason_code: 'PAYMENT_ISSUED',
      notes: `Reduced by issued payment of ${formatInr(reduce)}`,
      set_by: actorId,
      created_by: actorId,
      authority_ok: true,
      approval_status: 'POSTED',
    })
  }
}

export async function issuePayment(ctx, id, idempotencyKey) {
  requirePermission(ctx.actor, 'payments.issue')

  const prior = await ctx.db.findOne('payment_attempts', { idempotency_key: idempotencyKey })
  if (prior) {
    if (prior.payment_id !== id) throw conflict('This Idempotency-Key was already used for a different payment', 'IDEMPOTENCY_KEY_REUSED')
    const payment = await ctx.db.findById('payments', id)
    return { replayed: true, attempt: prior, payment: presentPayment(payment) }
  }

  // Phase 1: lock, validate, and move PENDING -> PROCESSING (compare-and-set).
  const { payment, attempt, payee } = await ctx.db.tx(async (t) => {
    const { payment: current } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    const claim = await lockClaim(t, current.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (current.status !== 'PENDING') {
      throw conflict(
        current.status === 'PROCESSING' ? 'This payment is already being processed' : `Payment is ${current.status.toLowerCase().replace('_', ' ')} and cannot be issued`,
        'PAYMENT_NOT_PENDING',
        { status: current.status },
      )
    }
    if (claim.status !== 'PAYMENT_PENDING') throw businessRule('INVALID_STAGE', 'The claim is not awaiting payment')
    const steps = await t.findMany('settlement_approval_steps', { where: { payment_id: id } })
    if (!steps.length || steps.some((s) => s.status !== 'APPROVED')) throw businessRule('SETTLEMENT_NOT_APPROVED', 'Payment requires an approved settlement')
    if (steps.some((s) => s.approver_id === ctx.actor.id)) {
      throw forbidden('You approved this settlement, so another Payment Operator must issue it', 'SEPARATION_OF_DUTIES')
    }
    if (await hasActiveComplianceHold(t, claim.id)) {
      throw businessRule('COMPLIANCE_HOLD_ACTIVE', 'Payment is blocked by an active compliance hold')
    }
    const payeeRow = current.payee_id ? await t.findById('payees', current.payee_id) : null
    if (payeeRow?.verification_status !== 'VERIFIED') throw businessRule('PAYEE_NOT_VERIFIED', 'The payee must be verified before payment')
    if (await t.count('payment_blocks', { payment_id: id, resolved_at: null })) {
      throw businessRule('PAYMENT_BLOCKED', 'Resolve the open payment blocks first')
    }

    const [locked] = await t.update('payments', { id, status: 'PENDING' }, { status: 'PROCESSING', attempt_count: current.attempt_count + 1, updated_by: ctx.actor.id })
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
    return { payment: locked, attempt: newAttempt, payee: payeeRow }
  })

  // Phase 2: call the adapter outside any transaction.
  let result
  try {
    result = await ctx.payments.initiateTransfer({
      paymentId: id,
      amount: payment.amount,
      currency: payment.currency,
      beneficiaryName: payee.name,
      beneficiaryAccount: ctx.crypto.decrypt(payee.bank_details_encrypted),
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
        ? { status: 'PAID', portal_reference: result.providerReference, issued_at: new Date(), last_failure_reason: null, block_reason: null }
        : { status: 'FAILED', last_failure_reason: result.failureReason, block_reason: result.failureReason },
    )
    const claim = await lockClaim(t, payment.claim_id)
    if (succeeded) {
      // The reserve reduces only on confirmed issuance (PRD 3.8).
      await reduceReserves(t, claim, payment.amount, ctx.actor.id)
    } else {
      const task = await t.insert('tasks', {
        claim_id: claim.id,
        title: `Resolve payment block on ${claim.claim_number}`,
        description: result.failureReason,
        type: 'PAYMENT_BLOCK',
        owner_role: ROLES.PAYMENT_OPERATOR,
        source_stage: 'PAYMENT',
        priority: 'HIGH',
        blocking: true,
        due_at: new Date(Date.now() + 24 * 3600_000),
        created_by: ctx.actor.id,
      })
      await t.insert('payment_blocks', {
        payment_id: id,
        block_type: 'PAYMENT_FAILED',
        detail: result.failureReason,
        opened_by: ctx.actor.id,
        owner_task_id: task.id,
      })
    }
    await transitionClaim(ctx, t, claim, succeeded ? 'PAID' : 'PAYMENT_FAILED', {
      system: true,
      reason: succeeded ? `Payment ${result.providerReference} issued` : result.failureReason,
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
        recipientIds: (await userIdsWithRole(t, ROLES.PAYMENT_OPERATOR)).filter((u) => u !== ctx.actor.id),
        claimId: claim.id,
        type: 'PAYMENT_FAILED',
        title: `Payment failed: ${claim.claim_number}`,
        message: result.failureReason,
        link: `/payments/${id}`,
        email: false,
      })
    }
    return { replayed: false, attempt: finishedAttempt, payment: presentPayment(updated, payee) }
  })
}

/** Resolves the payment-failed block and queues the payment again (FAILED -> PENDING). */
export async function resolveBlock(ctx, id, { resolution }) {
  requirePermission(ctx.actor, 'payments.issue')
  return ctx.db.tx(async (t) => {
    const { payment } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    const claim = await lockClaim(t, payment.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (payment.status !== 'FAILED') throw businessRule('PAYMENT_NOT_FAILED', 'Only failed payments can be queued again')
    const open = await t.findMany('payment_blocks', { where: { payment_id: id, resolved_at: null } })
    const unresolvable = open.filter((b) => b.block_type !== 'PAYMENT_FAILED')
    if (unresolvable.length) {
      throw businessRule('PAYMENT_BLOCKED', `Resolve first: ${unresolvable.map((b) => b.block_type.replace(/_/g, ' ').toLowerCase()).join(', ')}`)
    }
    const now = new Date()
    for (const b of open) {
      await t.updateById('payment_blocks', b.id, { resolved_by: ctx.actor.id, resolved_at: now, resolution })
      if (b.owner_task_id) await t.updateById('tasks', b.owner_task_id, { status: 'DONE', completed_at: now, completed_by: ctx.actor.id })
    }
    const updated = await t.updateById('payments', id, { status: 'PENDING', block_reason: null, updated_by: ctx.actor.id })
    await transitionClaim(ctx, t, claim, 'PAYMENT_PENDING', { reason: resolution })
    await recordAudit(t, ctx.actor, { action: 'PAYMENT_BLOCK_RESOLVED', entityType: 'payment', entityId: id, claimId: claim.id, before: payment, after: updated, metadata: { resolution } })
    return presentPayment(updated)
  })
}

/**
 * Records new bank details for the payee of a settlement. The payee becomes
 * unverified and a BANK_DETAILS_CHANGED block holds the payment until another
 * Payment Operator verifies the payee (PRD 7.2.5).
 */
export async function updateBeneficiary(ctx, id, input) {
  requirePermission(ctx.actor, 'payees.manage')
  return ctx.db.tx(async (t) => {
    const { payment, claim } = await loadPaymentForStaff(t, ctx, id, { forUpdate: true })
    requireNotOwnClaim(ctx.actor, claim)
    if (!['FAILED', 'PENDING', 'PENDING_APPROVAL'].includes(payment.status)) {
      throw businessRule('PAYMENT_LOCKED', 'Payee details can only change before payment or after a failure')
    }
    let payee = payment.payee_id ? await t.findOne('payees', { id: payment.payee_id }, { forUpdate: true }) : null
    const now = new Date()
    const values = {
      name: input.beneficiaryName,
      bank_name: input.beneficiaryBank || null,
      bank_details_encrypted: ctx.crypto.encrypt(input.beneficiaryAccount),
      bank_last4: input.beneficiaryAccount.slice(-4),
      bank_details_hash: ctx.crypto.hash(input.beneficiaryAccount),
      bank_details_changed_at: now,
      bank_details_changed_by: ctx.actor.id,
      verification_status: 'UNVERIFIED',
      verified_by: null,
      verified_at: null,
      updated_by: ctx.actor.id,
    }
    const before = payee
    if (payee) payee = await t.updateById('payees', payee.id, values)
    else {
      payee = await t.insert('payees', { ...values, customer_id: claim.customer_id, created_by: ctx.actor.id })
      await t.updateById('payments', id, { payee_id: payee.id })
    }
    await t.insert('payment_blocks', {
      payment_id: id,
      block_type: 'BANK_DETAILS_CHANGED',
      detail: `Bank details changed: ${input.reason}`,
      opened_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: 'PAYEE_BANK_DETAILS_CHANGED',
      entityType: 'payee',
      entityId: payee.id,
      claimId: claim.id,
      before,
      after: payee,
      metadata: { reason: input.reason, paymentId: id, newAccount: maskLast4(payee.bank_last4) },
    })
    return presentPayment(await t.findById('payments', id), payee)
  })
}

// Statuses in which the Claims Operations Manager may still record the payee at intake;
// once a settlement exists, Payment Operators change payee details on the payment.
const PAYEE_INTAKE_STATUSES = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT', 'INVESTIGATION', 'REOPENED', 'ON_HOLD']

function presentPayeeForStaff(payee, names, actor) {
  if (!payee) return null
  return {
    id: payee.id,
    name: payee.name,
    bank_name: payee.bank_name,
    account_masked: maskLast4(payee.bank_last4),
    has_bank_details: Boolean(payee.bank_details_encrypted),
    verification_status: payee.verification_status,
    verified_at: payee.verified_at,
    verified_by_name: nameOf(names, payee.verified_by),
    bank_details_changed_at: payee.bank_details_changed_at,
    bank_details_changed_by_name: nameOf(names, payee.bank_details_changed_by),
    changed_by_me: payee.bank_details_changed_by === actor.id,
  }
}

/** The payee the claim will be paid to (the policy's payout account), as collected at intake. */
export async function getClaimPayee(ctx, claimId) {
  if (!['payees.intake', 'payees.verify', 'payments.view'].some((p) => can(ctx.actor.roles, p))) {
    throw forbidden('Your role cannot view payee details')
  }
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireStaffView(ctx.actor, claim)
  const policy = claim.policy_id ? await ctx.db.findById('policies', claim.policy_id) : null
  const payee = policy?.payee_id ? await ctx.db.findById('payees', policy.payee_id) : null
  const names = payee ? await profileMap(ctx.db, [payee.verified_by, payee.bank_details_changed_by]) : {}
  return {
    payee: presentPayeeForStaff(payee, names, ctx.actor),
    canRecord: can(ctx.actor.roles, 'payees.intake') && PAYEE_INTAKE_STATUSES.includes(claim.status),
    canVerify:
      can(ctx.actor.roles, 'payees.verify') &&
      Boolean(payee?.bank_details_encrypted) &&
      payee.verification_status !== 'VERIFIED' &&
      payee.bank_details_changed_by !== ctx.actor.id &&
      payee.customer_id !== ctx.actor.id,
  }
}

/**
 * The Claims Operations Manager records (or corrects) the payee's bank details
 * at intake. The details are encrypted, the payee becomes unverified, and a
 * different person must verify them before the claim can leave intake.
 */
export async function recordClaimPayee(ctx, claimId, input) {
  requirePermission(ctx.actor, 'payees.intake')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (!PAYEE_INTAKE_STATUSES.includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Payee details are collected before settlement; after that, Payment Operators update them on the payment')
    }
    if (!claim.policy_id) throw businessRule('POLICY_REQUIRED', 'The claim has no policy to attach a payee to')
    const policy = await t.findOne('policies', { id: claim.policy_id }, { forUpdate: true })
    let payee = policy.payee_id ? await t.findOne('payees', { id: policy.payee_id }, { forUpdate: true }) : null
    const now = new Date()
    const values = {
      name: input.payeeName,
      bank_name: input.bankName || null,
      bank_details_encrypted: ctx.crypto.encrypt(input.accountNumber),
      bank_last4: input.accountNumber.slice(-4),
      bank_details_hash: ctx.crypto.hash(input.accountNumber),
      bank_details_changed_at: now,
      bank_details_changed_by: ctx.actor.id,
      verification_status: 'UNVERIFIED',
      verified_by: null,
      verified_at: null,
      updated_by: ctx.actor.id,
    }
    const before = payee
    if (payee) payee = await t.updateById('payees', payee.id, values)
    else {
      payee = await t.insert('payees', { ...values, customer_id: claim.customer_id, created_by: ctx.actor.id })
      await t.updateById('policies', policy.id, { payee_id: payee.id })
    }
    // Any payment already waiting on this payee is held until the new details are verified.
    const open = await t.findMany('payments', { where: { payee_id: payee.id, status: { in: ['PENDING_APPROVAL', 'PENDING', 'FAILED'] } }, columns: ['id'] })
    for (const p of open) {
      await t.insert('payment_blocks', { payment_id: p.id, block_type: 'BANK_DETAILS_CHANGED', detail: `Bank details changed at intake: ${input.reason}`, opened_by: ctx.actor.id })
    }
    await recordAudit(t, ctx.actor, {
      action: 'PAYEE_DETAILS_RECORDED',
      entityType: 'payee',
      entityId: payee.id,
      claimId,
      before,
      after: payee,
      metadata: { reason: input.reason, newAccount: maskLast4(payee.bank_last4), stage: 'INTAKE' },
    })
    const names = await profileMap(t, [payee.verified_by, payee.bank_details_changed_by])
    return presentPayeeForStaff(payee, names, ctx.actor)
  })
}

/** Payee verification by someone other than the person who last changed the bank details. */
export async function verifyPayee(ctx, payeeId, { notes }) {
  requirePermission(ctx.actor, 'payees.verify')
  return ctx.db.tx(async (t) => {
    const payee = await t.findOne('payees', { id: payeeId }, { forUpdate: true })
    if (!payee) throw notFound('Payee not found')
    if (payee.customer_id === ctx.actor.id) throw forbidden('You cannot verify your own payee record', 'CONFLICT_OF_INTEREST')
    if (payee.bank_details_changed_by === ctx.actor.id) {
      throw forbidden('Bank details you entered must be verified by someone else', 'SEPARATION_OF_DUTIES')
    }
    if (!payee.bank_details_encrypted) throw businessRule('BENEFICIARY_DETAILS_MISSING', 'Record bank details before verifying the payee')
    const now = new Date()
    const verified = await t.updateById('payees', payeeId, {
      verification_status: 'VERIFIED',
      verified_by: ctx.actor.id,
      verified_at: now,
      verification_notes: notes || null,
      sanctions_checked_at: now,
      updated_by: ctx.actor.id,
    })
    const payments = await t.findMany('payments', { where: { payee_id: payeeId }, columns: ['id', 'claim_id'] })
    if (payments.length) {
      await t.update(
        'payment_blocks',
        { payment_id: { in: payments.map((p) => p.id) }, block_type: { in: ['BANK_DETAILS_CHANGED', 'PAYEE_UNVERIFIED'] }, resolved_at: null },
        { resolved_by: ctx.actor.id, resolved_at: now, resolution: 'Payee verified' },
      )
    }
    await recordAudit(t, ctx.actor, {
      action: 'PAYEE_VERIFIED',
      entityType: 'payee',
      entityId: payeeId,
      claimId: payments[0]?.claim_id || null,
      before: payee,
      after: verified,
      metadata: { notes },
    })
    return { id: verified.id, verification_status: verified.verification_status, verified_at: verified.verified_at }
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
      cleared_at: new Date(),
      reconciled_by: ctx.actor.id,
      reconciliation_reference: reconciliationReference,
      updated_by: ctx.actor.id,
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
  const unreconciled = await ctx.db.findMany('payments', { where: { status: 'PAID' }, orderBy: [['issued_at', 'asc']], limit: 50 })
  const stuck = await ctx.db.findMany('payments', {
    where: { status: 'PROCESSING', updated_at: { lt: new Date(Date.now() - 15 * 60_000) } },
    limit: 50,
  })
  const failureReasons = await ctx.db.query(
    `select coalesce(failure_code, 'UNKNOWN') as code, count(*)::int as count from public.payment_attempts where status = 'FAILED' group by failure_code order by count desc`,
  )
  const openBlocks = await ctx.db.query(
    `select block_type, count(*)::int as count from public.payment_blocks where resolved_at is null group by block_type`,
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
    openBlocks,
    unreconciled: unreconciled.map((p) => ({ ...presentPayment(p), claim_number: claimMap[p.claim_id] })),
    stuckProcessing: stuck.map((p) => ({ ...presentPayment(p), claim_number: claimMap[p.claim_id] })),
  }
}
