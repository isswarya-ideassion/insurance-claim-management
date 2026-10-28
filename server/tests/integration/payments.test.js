import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

const paymentFor = async (number) => {
  const claim = await ctx.claimByNumber(number)
  return { claim, payment: await ctx.db.findOne('payments', { claim_id: claim.id }) }
}

describe('payment issuance (simulated adapter)', () => {
  it('requires an Idempotency-Key header', async () => {
    const { payment } = await paymentFor('HPC-2026-000112')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`)
    expect(res.status).toBe(422)
  })

  it('only allows payment operators to issue payments', async () => {
    const { payment } = await paymentFor('HPC-2026-000112')
    const res = await ctx.as('manager.maria').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'mgr-attempt-0001' })
    expect(res.status).toBe(403)
  })

  it('issues once, marks the claim paid and replays retries with the same key', async () => {
    const { claim, payment } = await paymentFor('HPC-2026-000112')
    const first = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.meta).toMatchObject({ replayed: false, simulated: true })
    expect(first.body.data.payment.status).toBe('PAID')
    expect(first.body.data.payment.portal_reference).toMatch(/^SIM-TXN-/)
    expect(first.body.data.payment.payee_account_masked).toBe('•••• 1187')
    expect(JSON.stringify(first.body.data)).not.toContain('40221187')
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAID')

    const replay = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(replay.status).toBe(200)
    expect(replay.body.meta.replayed).toBe(true)
    expect(await ctx.db.count('payment_attempts', { payment_id: payment.id })).toBe(1)

    const second = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'pay-112-attempt-2' })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('PAYMENT_NOT_PENDING')

    const alice = await ctx.userId('customer.alice')
    expect(await ctx.db.count('notifications', { recipient_id: alice, claim_id: claim.id, template: 'PAYMENT_SUCCEEDED', channel: 'IN_APP' })).toBe(1)
  })

  it('processes concurrent double-submissions exactly once', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const settlement = await ctx.db.findOne('payments', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    expect((await ctx.as('adjuster.adam').post(`/settlements/${settlement.id}/approvals`, { decision: 'APPROVED' })).status).toBe(200)
    const [a, b] = await Promise.all([
      ctx.as('payments.paul').post(`/payments/${settlement.id}/issue`, {}, { 'Idempotency-Key': 'race-key-aaaa' }),
      ctx.as('payments.paul').post(`/payments/${settlement.id}/issue`, {}, { 'Idempotency-Key': 'race-key-bbbb' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await ctx.db.count('payment_attempts', { payment_id: settlement.id })).toBe(1)
  })

  it('rejects reusing a key for a different payment', async () => {
    const { payment } = await paymentFor('HPC-2026-000113')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('blocks failed payments; new bank details need a second operator to verify before retrying', async () => {
    const { claim, payment } = await paymentFor('HPC-2026-000113')
    expect(payment.status).toBe('FAILED')
    expect(await ctx.db.count('payment_blocks', { payment_id: payment.id, resolved_at: null })).toBe(1)
    const blocked = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'retry-without-reset' })
    expect(blocked.status).toBe(409)

    // Resolving the block with the same details fails again: a new block and task are opened.
    const resolve1 = await ctx.as('payments.priya').post(`/payments/${payment.id}/resolve-block`, { resolution: 'Retry with same details' })
    expect(resolve1.status).toBe(200)
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAYMENT_PENDING')
    const fail = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'fail-again-0001' })
    expect(fail.status).toBe(200)
    expect(fail.body.data.payment.status).toBe('FAILED')
    expect(fail.body.data.attempt.failure_code).toBe('ACCOUNT_CLOSED')
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAYMENT_FAILED')
    expect(await ctx.db.count('tasks', { claim_id: claim.id, type: 'PAYMENT_BLOCK', status: 'OPEN' })).toBeGreaterThan(0)

    const fix = await ctx.as('payments.priya').patch(`/payments/${payment.id}/beneficiary`, {
      beneficiaryName: 'Chen Wei', beneficiaryAccount: '77319876', reason: 'Client supplied new account by phone',
    })
    expect(fix.status).toBe(200)
    expect(fix.body.data.payee_account_masked).toBe('•••• 9876')
    expect(fix.body.data.payee_verification).toBe('UNVERIFIED')
    const stillBlocked = await ctx.as('payments.priya').post(`/payments/${payment.id}/resolve-block`, { resolution: 'New account recorded' })
    expect(stillBlocked.status).toBe(409)
    expect(stillBlocked.body.error.message).toMatch(/bank details changed/)

    const selfVerify = await ctx.as('payments.priya').post(`/payees/${payment.payee_id}/verify`, { notes: 'Called client' })
    expect(selfVerify.status).toBe(403)
    expect(selfVerify.body.error.code).toBe('SEPARATION_OF_DUTIES')
    expect((await ctx.as('payments.paul').post(`/payees/${payment.payee_id}/verify`, { notes: 'Call-back to number on file' })).status).toBe(200)

    expect((await ctx.as('payments.priya').post(`/payments/${payment.id}/resolve-block`, { resolution: 'New verified account' })).status).toBe(200)
    const ok = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'succeed-now-0001' })
    expect(ok.body.data.payment.status).toBe('PAID')
    const attempts = await ctx.db.findMany('payment_attempts', { where: { payment_id: payment.id }, orderBy: [['attempt_no', 'asc']] })
    expect(attempts.map((a) => a.status)).toEqual(['FAILED', 'FAILED', 'SUCCEEDED'])

    const payee = await ctx.db.findById('payees', payment.payee_id)
    expect(payee.bank_details_encrypted).toMatch(/^v1:/)
    expect(payee.bank_details_encrypted).not.toContain('77319876')
    const audit = await ctx.db.findOne('audit_logs', { entity_id: payment.payee_id, action: 'PAYEE_BANK_DETAILS_CHANGED' })
    expect(JSON.stringify(audit.after)).not.toContain('77319876')
  })

  it('refuses a payee verified by the person who changed the bank details at the database level', async () => {
    const { payment } = await paymentFor('HPC-2026-000114')
    const priya = await ctx.userId('payments.priya')
    await expect(
      ctx.db.update('payees', { id: payment.payee_id }, { bank_details_changed_by: priya, verified_by: priya, verified_at: new Date(), verification_status: 'VERIFIED' }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('refuses an attempt initiated by the settlement approver at the database level', async () => {
    const { payment } = await paymentFor('HPC-2026-000115')
    const approver = await ctx.userId('adjuster.adam')
    await expect(
      ctx.db.insert('payment_attempts', { payment_id: payment.id, attempt_no: 9, idempotency_key: 'db-sod-check-1', provider: 'SIMULATED', initiated_by: approver }),
    ).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' })
  })

  it('audits every reveal of full bank details and restricts it to payment operators', async () => {
    const { payment } = await paymentFor('HPC-2026-000114')
    expect((await ctx.as('manager.maria').get(`/payments/${payment.id}/beneficiary`)).status).toBe(403)
    const res = await ctx.as('payments.priya').get(`/payments/${payment.id}/beneficiary`)
    expect(res.status).toBe(200)
    expect(res.body.data.beneficiaryAccount).toBe('55180342')
    expect(await ctx.db.count('audit_logs', { entity_id: payment.payee_id, action: 'BENEFICIARY_DETAILS_VIEWED' })).toBe(1)
  })

  it('reconciles paid payments and exposes a reconciliation summary', async () => {
    const { payment } = await paymentFor('HPC-2026-000114')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/reconcile`, { reconciliationReference: 'BANK-STMT-0919' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('RECONCILED')
    expect(res.body.data.cleared_at).toBeTruthy()
    const summary = await ctx.as('payments.priya').get('/payments/reconciliation/summary')
    expect(summary.body.data.simulated).toBe(true)
    expect(summary.body.data.attempts.total).toBeGreaterThan(0)
  })

  it('enforces the payment state machine in the database', async () => {
    const { payment } = await paymentFor('HPC-2026-000115')
    await expect(ctx.db.update('payments', { id: payment.id }, { status: 'PENDING' })).rejects.toMatchObject({ code: 'INVALID_PAYMENT_TRANSITION' })
  })

  it('shows clients a safe payment status without account numbers', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000114')
    const res = await ctx.as('customer.ben').get(`/claims/${claim.id}/payment-status`)
    expect(res.status).toBe(200)
    expect(res.body.data.payment).toMatchObject({ statusLabel: 'Paid', isSimulated: true, beneficiaryAccount: '•••• 0342' })
    expect((await ctx.as('customer.alice').get(`/claims/${claim.id}/payment-status`)).status).toBe(404)
  })
})
