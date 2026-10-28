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

describe('payment processing (simulated adapter)', () => {
  it('requires an Idempotency-Key header', async () => {
    const { payment } = await paymentFor('HPC-2026-000112')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`)
    expect(res.status).toBe(422)
  })

  it('only allows payment operations to process payments', async () => {
    const { payment } = await paymentFor('HPC-2026-000112')
    const res = await ctx.as('manager.maria').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'mgr-attempt-0001' })
    expect(res.status).toBe(403)
  })

  it('pays once, marks the claim paid and replays retries with the same key', async () => {
    const { claim, payment } = await paymentFor('HPC-2026-000112')
    const first = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.meta).toMatchObject({ replayed: false, simulated: true })
    expect(first.body.data.payment.status).toBe('PAID')
    expect(first.body.data.payment.transaction_reference).toMatch(/^SIM-TXN-/)
    expect(first.body.data.payment).not.toHaveProperty('beneficiary_account')
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAID')

    const replay = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(replay.status).toBe(200)
    expect(replay.body.meta.replayed).toBe(true)
    expect(await ctx.db.count('payment_attempts', { payment_id: payment.id })).toBe(1)

    const second = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'pay-112-attempt-2' })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('PAYMENT_NOT_PENDING')

    const ben = await ctx.userId('customer.alice')
    expect(await ctx.db.count('notifications', { recipient_id: ben, claim_id: claim.id, type: 'PAYMENT_SUCCEEDED' })).toBe(1)
  })

  it('processes concurrent double-submissions exactly once', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const settlement = await ctx.db.findOne('settlements', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    await ctx.as('manager.maria').post(`/settlements/${settlement.id}/decision`, { decision: 'APPROVED' })
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id })
    const [a, b] = await Promise.all([
      ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'race-key-aaaa' }),
      ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'race-key-bbbb' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await ctx.db.count('payment_attempts', { payment_id: payment.id })).toBe(1)
  })

  it('rejects reusing a key for a different payment', async () => {
    const { payment } = await paymentFor('HPC-2026-000113')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'pay-112-attempt-1' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('records failures, lets operations fix beneficiary details and retry', async () => {
    const { claim, payment } = await paymentFor('HPC-2026-000113')
    expect(payment.status).toBe('FAILED')
    const blocked = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'retry-without-reset' })
    expect(blocked.status).toBe(409)

    const retry1 = await ctx.as('payments.priya').post(`/payments/${payment.id}/retry`, { reason: 'Retry with same details' })
    expect(retry1.status).toBe(200)
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAYMENT_PENDING')
    const fail = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'fail-again-0001' })
    expect(fail.status).toBe(200)
    expect(fail.body.data.payment.status).toBe('FAILED')
    expect(fail.body.data.attempt.failure_code).toBe('ACCOUNT_CLOSED')
    expect((await ctx.db.findById('claims', claim.id)).status).toBe('PAYMENT_FAILED')

    const fix = await ctx.as('payments.priya').patch(`/payments/${payment.id}/beneficiary`, {
      beneficiaryName: 'Chen Wei', beneficiaryAccount: '77319876', reason: 'Customer supplied new account by phone',
    })
    expect(fix.status).toBe(200)
    expect(fix.body.data.beneficiary_account_masked).toBe('•••• 9876')
    await ctx.as('payments.priya').post(`/payments/${payment.id}/retry`, {})
    const ok = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'succeed-now-0001' })
    expect(ok.body.data.payment.status).toBe('PAID')
    const attempts = await ctx.db.findMany('payment_attempts', { where: { payment_id: payment.id }, orderBy: [['attempt_no', 'asc']] })
    expect(attempts.map((a) => a.status)).toEqual(['FAILED', 'FAILED', 'SUCCEEDED'])

    const audit = await ctx.db.findOne('audit_logs', { entity_id: payment.id, action: 'BENEFICIARY_UPDATED' })
    expect(JSON.stringify(audit.after_data)).not.toContain('77319876')
  })

  it('audits every reveal of full beneficiary details and restricts it to payment operations', async () => {
    const { payment } = await paymentFor('HPC-2026-000114')
    expect((await ctx.as('manager.maria').get(`/payments/${payment.id}/beneficiary`)).status).toBe(403)
    const res = await ctx.as('payments.priya').get(`/payments/${payment.id}/beneficiary`)
    expect(res.status).toBe(200)
    expect(res.body.data.beneficiaryAccount).toBe('55180342')
    expect(await ctx.db.count('audit_logs', { entity_id: payment.id, action: 'BENEFICIARY_DETAILS_VIEWED' })).toBe(1)
  })

  it('reconciles paid payments and exposes a reconciliation summary', async () => {
    const { payment } = await paymentFor('HPC-2026-000114')
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/reconcile`, { reconciliationReference: 'BANK-STMT-0919' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('RECONCILED')
    const summary = await ctx.as('payments.priya').get('/payments/reconciliation/summary')
    expect(summary.body.data.simulated).toBe(true)
    expect(summary.body.data.attempts.total).toBeGreaterThan(0)
  })

  it('enforces the payment state machine in the database', async () => {
    const { payment } = await paymentFor('HPC-2026-000115')
    await expect(ctx.db.update('payments', { id: payment.id }, { status: 'PENDING' })).rejects.toMatchObject({ code: 'INVALID_PAYMENT_TRANSITION' })
  })

  it('shows customers a safe payment status without account numbers', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000114')
    const res = await ctx.as('customer.ben').get(`/claims/${claim.id}/payment-status`)
    expect(res.status).toBe(200)
    expect(res.body.data.payment).toMatchObject({ statusLabel: 'Paid', isSimulated: true, beneficiaryAccount: '•••• 0342' })
    expect((await ctx.as('customer.alice').get(`/claims/${claim.id}/payment-status`)).status).toBe(404)
  })
})
