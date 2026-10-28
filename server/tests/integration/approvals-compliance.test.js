import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

const pendingReserve = async (number) => {
  const claim = await ctx.claimByNumber(number)
  return { claim, reserve: await ctx.db.findOne('reserves', { claim_id: claim.id, approval_status: 'PENDING_REVIEW' }) }
}

const fullChecklist = { SANCTIONS_SCREENING: true, AML_CHECK: true, KYC_VERIFIED: true, FRAUD_SCORE_REVIEWED: true, CONFLICT_OF_INTEREST: true }

describe('reserve management (decision node)', () => {
  it('blocks a manager above their reserve authority for the segment', async () => {
    const { reserve } = await pendingReserve('HPC-2026-000108')
    const res = await ctx.as('manager.maria').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('APPROVAL_LIMIT_EXCEEDED')
  })

  it('lets a manager with enough authority approve and records an immutable reverse review', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000108')
    const res = await ctx.as('manager.sam').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED', comments: 'Within authority' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.status).toBe('COMPLIANCE_REVIEW')
    const review = await ctx.db.findOne('reviews', { subject_id: reserve.id, checkpoint_type: 'RESERVE' })
    expect(review).toMatchObject({ outcome: 'APPROVED', approver_limit: 250000 })
    await expect(ctx.db.update('reviews', { id: review.id }, { comments: 'changed' })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    expect(await ctx.db.count('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE', status: 'PENDING' })).toBe(1)
    const again = await ctx.as('manager.sam').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED' })
    expect(again.status).toBe(409)
  })

  it('forbids non-managers from reviewing reserves', async () => {
    const { reserve } = await pendingReserve('HPC-2026-000107')
    expect((await ctx.as('adjuster.adam').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED' })).status).toBe(403)
    expect((await ctx.as('compliance.carlos').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED' })).status).toBe(403)
  })

  it('prevents self-approval and over-limit approval at the database level', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000107')
    const maria = await ctx.userId('manager.maria')
    await expect(
      ctx.db.insert('reviews', {
        claim_id: claim.id, checkpoint_type: 'RESERVE', subject_type: 'reserve', subject_id: reserve.id, status: 'DECIDED',
        outcome: 'APPROVED', amount: 10, requested_by: maria, decided_by: maria, reviewed_at: new Date(),
      }),
    ).rejects.toMatchObject({ status: 422 })
    await expect(ctx.db.update('reserves', { id: reserve.id }, { amount: 1 })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
  })

  it('returns an evaluation; a resubmitted reserve within adjuster authority is posted and skips manager review', async () => {
    const { claim, reserve } = await pendingReserve('HPC-2026-000107')
    const res = await ctx.as('manager.maria').post(`/reserves/${reserve.id}/review`, { decision: 'RETURNED', comments: 'Exclude the physiotherapy invoice' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.status).toBe('INVESTIGATION')
    const original = await ctx.db.findOne('evaluations', { claim_id: claim.id, version_no: 1 })
    expect(original.status).toBe('RETURNED')
    expect(original.review_comment).toBe('Exclude the physiotherapy invoice')

    const v2 = await ctx.as('adjuster.amara').post(`/claims/${claim.id}/evaluations`, { recommendedSettlement: 14000, liabilityPct: 100 })
    expect(v2.status).toBe(201)
    expect(v2.body.data.version_no).toBe(2)
    expect(v2.body.data.findings).toBe(original.findings)
    const submit = await ctx.as('adjuster.amara').post(`/evaluations/${v2.body.data.id}/submit`, { reserveAmount: 14000 })
    expect(submit.status, JSON.stringify(submit.body)).toBe(200)
    expect(submit.body.data.reserve).toMatchObject({ approval_status: 'POSTED', authority_ok: true, coverage_line: 'MEDICAL' })
    expect(submit.body.data.claim.status).toBe('COMPLIANCE_REVIEW')
    const list = await ctx.as('manager.maria').get(`/claims/${claim.id}/evaluations`)
    expect(list.body.data.map((a) => [a.version_no, a.status])).toEqual([[2, 'SUBMITTED'], [1, 'RETURNED']])
    const decisions = await ctx.as('manager.maria').get(`/claims/${claim.id}/approvals`)
    expect(decisions.body.data[0]).toMatchObject({ approval_type: 'RESERVE', decision: 'RETURNED' })
  })

  it('escalates a revised reserve above authority; the manager can modify the amount (new ledger entry)', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const revise = await ctx.as('adjuster.adam').post(`/claims/${claim.id}/reserves`, { amount: 20000, reasonCode: 'REVISED_ESTIMATE', notes: 'Laptop value confirmed' })
    expect(revise.status).toBe(201)
    expect(revise.body.data.reserve).toMatchObject({ approval_status: 'PENDING_REVIEW', authority_ok: false })
    const res = await ctx.as('manager.maria').post(`/reserves/${revise.body.data.reserve.id}/review`, { decision: 'MODIFIED', modifiedAmount: 16000, comments: 'Depreciate the laptop' })
    expect(res.status).toBe(200)
    expect(res.body.data.reserve).toMatchObject({ amount: 16000, prev_amount: 20000, approval_status: 'APPROVED', reason_code: 'MANAGER_MODIFIED' })
    expect((await ctx.db.findById('reserves', revise.body.data.reserve.id)).approval_status).toBe('MODIFIED')
    expect(res.body.data.claim.status).toBe('INVESTIGATION')
  })

  it('only lets the assigned adjuster work on an evaluation', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const res = await ctx.as('adjuster.amara').post(`/claims/${claim.id}/evaluations`, {})
    expect(res.status).toBe(404)
  })
})

describe('compliance and fraud governance', () => {
  it('blocks clearance while a high-severity flag is unresolved and blocks the settlement transition', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000109')
    const review = await ctx.db.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE' })
    const tr = await ctx.as('compliance.carlos').post(`/claims/${claim.id}/transitions`, { toStatus: 'SETTLEMENT_APPROVAL' })
    expect(tr.status).toBe(409)
    expect(tr.body.error.details.failures.map((f) => f.guard)).toContain('noActiveComplianceHold')

    expect((await ctx.as('compliance.carlos').patch(`/compliance-reviews/${review.id}`, { checklist: fullChecklist })).status).toBe(200)
    const clear = await ctx.as('compliance.carlos').post(`/compliance-reviews/${review.id}/decision`, { decision: 'CLEAR' })
    expect(clear.status).toBe(409)
    expect(clear.body.error.code).toBe('HIGH_RISK_UNRESOLVED')
  })

  it('permits an authorised exception, then prepares a settlement routed by authority', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000109')
    const review = await ctx.db.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE' })
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
    // 34,900 exceeds the adjuster's settlement limit for the personal segment, so a Claims Manager must approve.
    const step = await ctx.db.findOne('settlement_approval_steps', { payment_id: res.body.data.settlement.id })
    expect(step).toMatchObject({ step_no: 1, required_role: 'OPS_MANAGER', status: 'PENDING' })
  })

  it('raises the claim fraud score from flags with approved reason codes', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000110')
    const review = await ctx.db.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE' })
    const res = await ctx.as('compliance.carlos').patch(`/compliance-reviews/${review.id}`, {
      riskFlags: [{ code: 'DUPLICATE_SUSPECTED', severity: 'MEDIUM', note: 'Similar baggage claim last year', resolved: false }],
    })
    expect(res.status).toBe(200)
    expect((await ctx.claimByNumber('HPC-2026-000110')).fraud_score).toBe(21)
    const flag = await ctx.db.findOne('claim_fraud_flags', { claim_id: claim.id })
    expect((await ctx.as('compliance.carlos').patch(`/compliance-reviews/${review.id}`, { riskFlags: [{ id: flag.id, code: flag.code, severity: 'MEDIUM', resolved: true }] })).status).toBe(200)
    expect((await ctx.claimByNumber('HPC-2026-000110')).fraud_score).toBeNull()
  })

  it('blocks payment issuance when a hold is placed on a claim awaiting payment', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000112')
    const hold = await ctx.as('compliance.carlos').post(`/claims/${claim.id}/compliance-reviews`, { placeHold: true, notes: 'Late fraud alert received' })
    expect(hold.status).toBe(201)
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id })
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'hold-test-key-1' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('COMPLIANCE_HOLD_ACTIVE')
    expect((await ctx.db.findById('payments', payment.id)).status).toBe('PENDING')
    const maria = await ctx.userId('manager.maria')
    expect(await ctx.db.count('notifications', { recipient_id: maria, claim_id: claim.id, template: 'COMPLIANCE_HOLD', channel: 'IN_APP' })).toBe(1)

    await ctx.as('compliance.carlos').patch(`/compliance-reviews/${hold.body.data.id}`, { checklist: fullChecklist })
    const clear = await ctx.as('compliance.carlos').post(`/compliance-reviews/${hold.body.data.id}/decision`, { decision: 'CLEAR', notes: 'Alert was a false positive' })
    expect(clear.status).toBe(200)
    expect(clear.body.data.claim.status).toBe('PAYMENT_PENDING')
  })

  it('enforces the hold in the database even if the API were bypassed', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000110')
    await ctx.db.insert('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE', status: 'HOLD', hold_active: true })
    await expect(ctx.db.update('claims', { id: claim.id }, { status: 'SETTLEMENT_APPROVAL' })).rejects.toMatchObject({ code: 'COMPLIANCE_HOLD_ACTIVE' })
  })
})

describe('settlement approval and separation of duties', () => {
  it('lets only the assigned adjuster decide an adjuster step, even bypassing the API', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    const step = await ctx.db.findOne('settlement_approval_steps', { payment_id: payment.id, status: 'PENDING' })
    await expect(
      ctx.db.update('settlement_approval_steps', { id: step.id }, { status: 'APPROVED', approver_id: await ctx.userId('adjuster.amara') }),
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_AUTHORISED' })
  })

  it('routes a settlement within adjuster authority to the assigned adjuster', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    const step = await ctx.db.findOne('settlement_approval_steps', { payment_id: payment.id, status: 'PENDING' })
    expect(step.required_role).toBe('ADJUSTER')

    const manager = await ctx.as('manager.maria').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })
    expect(manager.status).toBe(403)
    expect(manager.body.error.code).toBe('APPROVAL_NOT_AUTHORISED')
    expect((await ctx.as('payments.priya').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })).status).toBe(403)
    // Another adjuster cannot see the claim at all.
    expect((await ctx.as('adjuster.amara').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })).status).toBe(404)

    const queue = await ctx.as('adjuster.adam').get('/settlements/queue')
    expect(queue.body.data.find((i) => i.id === payment.id)).toMatchObject({ required_role: 'ADJUSTER', canApprove: true })
    expect((await ctx.as('adjuster.amara').get('/settlements/queue')).body.data.find((i) => i.id === payment.id)).toBeUndefined()

    const res = await ctx.as('adjuster.adam').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.claim.status).toBe('PAYMENT_PENDING')
    expect(res.body.data.settlement.status).toBe('PENDING')
    expect(res.body.data.step).toMatchObject({ status: 'APPROVED', approver_limit_at_decision: 15000 })
    const history = await ctx.as('manager.maria').get(`/claims/${claim.id}/approvals`)
    expect(history.body.data.find((d) => d.approval_type === 'SETTLEMENT').decision).toBe('APPROVED')
  })

  it('stops the approver from issuing the payment; a Payment Operator issues it and the reserve reduces', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id })
    expect((await ctx.as('adjuster.adam').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'sod-test-key-01' })).status).toBe(403)
    // The database also refuses an attempt initiated by the approver.
    await expect(ctx.db.insert('payment_attempts', {
      payment_id: payment.id, attempt_no: 1, idempotency_key: 'sod-db-key-01', status: 'PROCESSING', provider: 'SIMULATED',
      initiated_by: await ctx.userId('adjuster.adam'),
    })).rejects.toMatchObject({ code: 'SEPARATION_OF_DUTIES' })
    const res = await ctx.as('payments.priya').post(`/payments/${payment.id}/issue`, {}, { 'Idempotency-Key': 'sod-test-key-02' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.payment.status).toBe('PAID')
    const ledger = await ctx.db.findMany('reserves', { where: { claim_id: claim.id }, orderBy: [['effective_at', 'desc']] })
    expect(ledger[0]).toMatchObject({ reason_code: 'PAYMENT_ISSUED', amount: 200, prev_amount: 8000, approval_status: 'POSTED' })
  })

  it('needs a Claims Manager with enough authority for larger settlements', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000109')
    const payment = await ctx.db.findOne('payments', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    const adjuster = await ctx.as('adjuster.amara').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })
    expect(adjuster.status).toBe(403)
    expect(adjuster.body.error.code).toBe('APPROVAL_NOT_AUTHORISED')
    const ok = await ctx.as('manager.maria').post(`/settlements/${payment.id}/approvals`, { decision: 'APPROVED' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.claim.status).toBe('PAYMENT_PENDING')
  })
})
