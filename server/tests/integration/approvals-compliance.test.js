import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

const pendingReserve = async (number) => {
  const claim = await ctx.claimByNumber(number)
  return { claim, reserve: await ctx.db.findOne('reserves', { claim_id: claim.id, status: 'PENDING_APPROVAL' }) }
}

describe('reserve approval', () => {
  it('blocks approvals above the manager’s limit', async () => {
    const { reserve } = await pendingReserve('HPC-2026-000108')
    const res = await ctx.as('manager.maria').post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('APPROVAL_LIMIT_EXCEEDED')
  })

  it('lets a manager with sufficient authority approve, records the decision and opens compliance review', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000108')
    const res = await ctx.as('manager.sam').post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED', comments: 'Within authority' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.status).toBe('COMPLIANCE_REVIEW')
    const approval = await ctx.db.findOne('approvals', { reserve_id: reserve.id })
    expect(approval).toMatchObject({ approval_type: 'RESERVE', decision: 'APPROVED', approver_limit: 250000 })
    expect(await ctx.db.count('compliance_reviews', { claim_id: claim.id, status: 'PENDING' })).toBe(1)
    const again = await ctx.as('manager.sam').post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED' })
    expect(again.status).toBe(409)
  })

  it('forbids non-managers from deciding reserves', async () => {
    const { reserve } = await pendingReserve('HPC-2026-000107')
    expect((await ctx.as('adjuster.adam').post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED' })).status).toBe(403)
    expect((await ctx.as('auditor.ade').post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED' })).status).toBe(403)
  })

  it('prevents self-approval at the database level', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000107')
    const maria = await ctx.userId('manager.maria')
    await expect(
      ctx.db.insert('approvals', {
        claim_id: claim.id, approval_type: 'RESERVE', reserve_id: reserve.id, amount: 10, decision: 'APPROVED', requested_by: maria, decided_by: maria,
      }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it('returns an assessment for correction and preserves its history', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000107')
    const res = await ctx.as('manager.maria').post(`/reserves/${reserve.id}/decision`, { decision: 'RETURNED', comments: 'Exclude the physiotherapy invoice' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.status).toBe('INVESTIGATION')
    const original = await ctx.db.findOne('assessments', { claim_id: claim.id, version_no: 1 })
    expect(original.status).toBe('RETURNED')
    expect(original.review_comment).toBe('Exclude the physiotherapy invoice')

    const v2 = await ctx.as('adjuster.amara').post(`/claims/${claim.id}/assessments`, { recommendedSettlement: 17000 })
    expect(v2.status).toBe(201)
    expect(v2.body.data.version_no).toBe(2)
    expect(v2.body.data.findings).toBe(original.findings)
    const submit = await ctx.as('adjuster.amara').post(`/assessments/${v2.body.data.id}/submit`, { reserveAmount: 17000 })
    expect(submit.status, JSON.stringify(submit.body)).toBe(200)
    expect(submit.body.data.claim.status).toBe('RESERVE_APPROVAL')
    const list = await ctx.as('manager.maria').get(`/claims/${claim.id}/assessments`)
    expect(list.body.data.map((a) => [a.version_no, a.status])).toEqual([[2, 'SUBMITTED'], [1, 'RETURNED']])
    const decisions = await ctx.as('manager.maria').get(`/claims/${claim.id}/approvals`)
    expect(decisions.body.data[0].decision).toBe('RETURNED')
  })

  it('only lets the assigned adjuster work on an assessment', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const res = await ctx.as('adjuster.amara').post(`/claims/${claim.id}/assessments`, {})
    expect(res.status).toBe(404)
  })
})

describe('compliance holds', () => {
  it('blocks clearance while a high-severity flag is unresolved and blocks the settlement transition', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000109')
    const review = await ctx.db.findOne('compliance_reviews', { claim_id: claim.id })
    const tr = await ctx.as('compliance.carlos').post(`/claims/${claim.id}/transitions`, { toStatus: 'SETTLEMENT_APPROVAL' })
    expect(tr.status).toBe(409)
    expect(tr.body.error.details.failures.map((f) => f.guard)).toContain('noActiveComplianceHold')

    const items = { SANCTIONS_SCREENING: true, AML_CHECK: true, KYC_VERIFIED: true, FRAUD_SCORE_REVIEWED: true, CONFLICT_OF_INTEREST: true }
    expect((await ctx.as('compliance.carlos').patch(`/compliance-reviews/${review.id}`, { checklist: items })).status).toBe(200)
    const clear = await ctx.as('compliance.carlos').post(`/compliance-reviews/${review.id}/decision`, { decision: 'CLEAR' })
    expect(clear.status).toBe(409)
    expect(clear.body.error.code).toBe('HIGH_RISK_UNRESOLVED')
  })

  it('permits an authorised exception, then creates the settlement request and advances the claim', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000109')
    const review = await ctx.db.findOne('compliance_reviews', { claim_id: claim.id })
    const notOfficer = await ctx.as('manager.maria').post(`/compliance-reviews/${review.id}/decision`, { decision: 'EXCEPTION', exceptionReason: 'Contractor verified as a different legal entity.' })
    expect(notOfficer.status).toBe(403)
    const res = await ctx.as('compliance.carlos').post(`/compliance-reviews/${review.id}/decision`, {
      decision: 'EXCEPTION',
      exceptionReason: 'Contractor verified as a different legal entity via company registry.',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.review).toMatchObject({ status: 'EXCEPTION_APPROVED', hold_active: false })
    expect(res.body.data.claim.status).toBe('SETTLEMENT_APPROVAL')
    expect(res.body.data.settlement).toMatchObject({ status: 'PENDING_APPROVAL', amount: 34900 })
  })

  it('blocks payment processing when a hold is placed on a claim awaiting payment', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000112')
    const hold = await ctx.as('compliance.carlos').post(`/claims/${claim.id}/compliance-reviews`, { placeHold: true, notes: 'Late fraud alert received' })
    expect(hold.status).toBe(201)
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id })
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': 'hold-test-key-1' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('COMPLIANCE_HOLD_ACTIVE')
    expect((await ctx.db.findById('payments', payment.id)).status).toBe('PENDING')
    const maria = await ctx.userId('manager.maria')
    expect(await ctx.db.count('notifications', { recipient_id: maria, claim_id: claim.id, type: 'COMPLIANCE_HOLD' })).toBe(1)

    const items = { SANCTIONS_SCREENING: true, AML_CHECK: true, KYC_VERIFIED: true, FRAUD_SCORE_REVIEWED: true, CONFLICT_OF_INTEREST: true }
    await ctx.as('compliance.carlos').patch(`/compliance-reviews/${hold.body.data.id}`, { checklist: items })
    const clear = await ctx.as('compliance.carlos').post(`/compliance-reviews/${hold.body.data.id}/decision`, { decision: 'CLEAR', notes: 'Alert was a false positive' })
    expect(clear.status).toBe(200)
    expect(clear.body.data.claim.status).toBe('PAYMENT_PENDING')
  })

  it('enforces the hold in the database even if the API were bypassed', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000110')
    await ctx.db.insert('compliance_reviews', { claim_id: claim.id, status: 'HOLD', hold_active: true })
    await expect(ctx.db.update('claims', { id: claim.id }, { status: 'SETTLEMENT_APPROVAL' })).rejects.toMatchObject({ code: 'COMPLIANCE_HOLD_ACTIVE' })
  })
})

describe('settlement approval', () => {
  it('approves within limits, creates exactly one payment request and notifies payment operations', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const settlement = await ctx.db.findOne('settlements', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    const res = await ctx.as('manager.maria').post(`/settlements/${settlement.id}/decision`, { decision: 'APPROVED' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.status).toBe('PAYMENT_PENDING')
    expect(await ctx.db.count('payments', { settlement_id: settlement.id })).toBe(1)
    const priya = await ctx.userId('payments.priya')
    expect(await ctx.db.count('notifications', { recipient_id: priya, claim_id: claim.id })).toBeGreaterThan(0)
    const approvals = await ctx.db.findMany('approvals', { where: { claim_id: claim.id, approval_type: 'SETTLEMENT' } })
    expect(approvals).toHaveLength(1)
    expect(await ctx.db.count('approvals', { claim_id: claim.id, approval_type: 'RESERVE' })).toBe(1)
  })
})
