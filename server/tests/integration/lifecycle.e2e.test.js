import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, completeDraft, samplePdf, uniqueKey } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('claim lifecycle: draft to closure', () => {
  it('runs every stage through the API with the correct actors', async () => {
    const alice = ctx.as('customer.alice')
    const ops = ctx.as('ops.olivia')
    const raj = ctx.as('reviewer.raj')
    const maria = ctx.as('manager.maria')
    const adam = ctx.as('adjuster.adam')
    const carlos = ctx.as('compliance.carlos')
    const priya = ctx.as('payments.priya')
    const expectOk = (res, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status)

    // Customer drafts and submits
    const draft = await alice.post('/claims', { policyNumber: 'HP-MOT-100231', draftStep: 1 })
    expectOk(draft, 201)
    const id = draft.body.data.id
    expectOk(await alice.patch(`/claims/${id}`, completeDraft('HP-MOT-100231', { incidentAt: new Date(Date.now() - 70 * 86_400_000).toISOString() })))
    for (const [category, name] of [['PROOF_OF_LOSS', 'proof.pdf'], ['PHOTOS', 'photos.pdf'], ['REPAIR_ESTIMATE', 'estimate.pdf']]) {
      expectOk(await alice.upload(`/claims/${id}/documents`, { buffer: samplePdf(name), filename: name, fields: { category } }), 201)
    }
    const submitted = await alice.post(`/claims/${id}/submit`, { submissionKey: uniqueKey() })
    expectOk(submitted, 201)

    // Operations intake
    expectOk(await ops.post(`/claims/${id}/transitions`, { toStatus: 'POLICY_VERIFICATION' }))
    expectOk(await ops.post(`/claims/${id}/verify-policy`, { verified: true, notes: 'Matches policy record' }))
    expectOk(await ops.patch(`/claims/${id}/intake-checklist`, { items: { POLICY_ACTIVE: true, COVERAGE_CONFIRMED: true, CLAIMANT_IDENTITY: true, DUPLICATE_CHECK: true, CONTACT_VERIFIED: true } }))
    expectOk(await ops.post(`/claims/${id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' }))

    // Document review
    const rajId = await ctx.userId('reviewer.raj')
    expectOk(await ops.post(`/claims/${id}/assignments`, { assigneeId: rajId, assignmentRole: 'DOCUMENT_REVIEWER' }), 201)
    const queue = await raj.get('/documents/review-queue?mine=true&pageSize=50')
    const mine = queue.body.data.filter((d) => d.claim_id === id)
    expect(mine).toHaveLength(3)
    for (const doc of mine) expectOk(await raj.post(`/documents/${doc.id}/review`, { decision: 'ACCEPT' }))
    expectOk(await raj.post(`/claims/${id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' }))

    // Manager assigns an adjuster
    expectOk(await maria.post(`/claims/${id}/assignments`, { assigneeId: await ctx.userId('adjuster.adam'), assignmentRole: 'ADJUSTER' }), 201)

    // Adjuster investigation and assessment
    const assessment = await adam.post(`/claims/${id}/assessments`, {
      checklist: { SITE_INSPECTION: true, STATEMENTS_COLLECTED: true, EVIDENCE_REVIEWED: true, COVERAGE_ANALYSIS: true, FRAUD_INDICATORS: true },
      findings: 'Damage consistent with rear-end collision; repair estimate verified with approved garage.',
      estimatedLoss: 2400,
      recommendedSettlement: 1900,
      recommendation: 'PAY_PARTIAL',
      internalNotes: 'Deductible of 500 applied.',
    })
    expectOk(assessment, 201)
    expectOk(await adam.post(`/assessments/${assessment.body.data.id}/submit`, { reserveAmount: 2000, reserveReason: 'Repair plus contingency' }))

    // Reserve approval
    const reserve = (await maria.get(`/claims/${id}/reserves`)).body.data.find((r) => r.status === 'PENDING_APPROVAL')
    expect(reserve.canApprove).toBe(true)
    expectOk(await maria.post(`/reserves/${reserve.id}/decision`, { decision: 'APPROVED' }))

    // Compliance clearance creates the settlement request
    const review = (await carlos.get(`/claims/${id}/compliance-reviews`)).body.data[0]
    expectOk(await carlos.patch(`/compliance-reviews/${review.id}`, { checklist: { SANCTIONS_SCREENING: true, AML_CHECK: true, KYC_VERIFIED: true, FRAUD_SCORE_REVIEWED: true, CONFLICT_OF_INTEREST: true } }))
    const cleared = await carlos.post(`/compliance-reviews/${review.id}/decision`, { decision: 'CLEAR', notes: 'No concerns' })
    expectOk(cleared)
    expect(cleared.body.data.settlement.amount).toBe(1900)

    // Settlement approval and payment
    expectOk(await maria.post(`/settlements/${cleared.body.data.settlement.id}/decision`, { decision: 'APPROVED' }))
    const payment = (await priya.get(`/claims/${id}/payments`)).body.data[0]
    const paid = await priya.post(`/payments/${payment.id}/process`, {}, { 'Idempotency-Key': `e2e-${uniqueKey()}` })
    expectOk(paid)
    expect(paid.body.data.payment.status).toBe('PAID')

    // Closure
    const closed = await ops.post(`/claims/${id}/transitions`, { toStatus: 'CLOSED' })
    expectOk(closed)
    expect(closed.body.data.status).toBe('CLOSED')

    // Customer view of the outcome
    const timeline = await alice.get(`/claims/${id}/timeline`)
    const titles = timeline.body.data.map((e) => e.title)
    expect(titles).toEqual(expect.arrayContaining(['Submitted', 'Paid', 'Closed']))
    expect(timeline.body.data.every((e) => e.type !== 'AUDIT' && e.type !== 'INTERNAL_NOTE')).toBe(true)
    const notifications = await alice.get('/notifications?pageSize=100')
    const types = notifications.body.data.filter((n) => n.claim_id === id).map((n) => n.type)
    expect(types).toEqual(expect.arrayContaining(['CLAIM_SUBMITTED', 'DOCUMENT_ACCEPTED', 'INVESTIGATION_UPDATE', 'PAYMENT_SUCCEEDED', 'CLAIM_CLOSED']))

    const history = await ctx.db.findMany('claim_status_history', { where: { claim_id: id }, orderBy: [['created_at', 'asc']] })
    expect(history.map((h) => h.to_status)).toEqual([
      'SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT', 'INVESTIGATION',
      'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAID', 'CLOSED',
    ])
  })
})
