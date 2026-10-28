import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, completeDraft, samplePdf, uniqueKey } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('claim lifecycle: FNOL to closure across the nine stages', () => {
  it('runs every stage through the API with the correct actors', async () => {
    const alice = ctx.as('customer.alice')
    const ops = ctx.as('ops.olivia')
    const raj = ctx.as('reviewer.raj')
    const maria = ctx.as('manager.maria')
    const adam = ctx.as('adjuster.adam')
    const carlos = ctx.as('compliance.carlos')
    const priya = ctx.as('payments.priya')
    const expectOk = (res, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status)

    // FNOL: client drafts, uploads and submits
    const draft = await alice.post('/claims', { policyNumber: 'HP-MOT-100231', draftStep: 1 })
    expectOk(draft, 201)
    const id = draft.body.data.id
    expectOk(await alice.patch(`/claims/${id}`, completeDraft('HP-MOT-100231', { lossDate: new Date(Date.now() - 70 * 86_400_000).toISOString() })))
    for (const [docType, name] of [['PROOF_OF_LOSS', 'proof.pdf'], ['PHOTOS', 'photos.pdf'], ['REPAIR_ESTIMATE', 'estimate.pdf']]) {
      expectOk(await alice.upload(`/claims/${id}/documents`, { buffer: samplePdf(name), filename: name, fields: { docType } }), 201)
    }
    const submitted = await alice.post(`/claims/${id}/submit`, { submissionKey: uniqueKey() })
    expectOk(submitted, 201)
    // Draft uploads count as received against the required artifacts created at FNOL.
    expect(await ctx.db.count('artifact_requirements', { claim_id: id, is_required: true, status: 'RECEIVED' })).toBe(3)

    // Coverage verification against the FNOL snapshot
    expectOk(await ops.post(`/claims/${id}/transitions`, { toStatus: 'POLICY_VERIFICATION' }))
    expectOk(await ops.post(`/claims/${id}/coverage-check`, { result: 'COVERED', notes: 'Matches policy snapshot' }))
    expectOk(await ops.patch(`/claims/${id}/intake-checklist`, { items: { POLICY_ACTIVE: true, COVERAGE_CONFIRMED: true, CLAIMANT_IDENTITY: true, DUPLICATE_CHECK: true, CONTACT_VERIFIED: true } }))
    expectOk(await ops.post(`/claims/${id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' }))

    // Document intake and review
    const rajId = await ctx.userId('reviewer.raj')
    expectOk(await ops.post(`/claims/${id}/assignments`, { assigneeId: rajId, assignmentRole: 'DOCUMENT_REVIEWER' }), 201)
    const queue = await raj.get('/documents/review-queue?mine=true&pageSize=50')
    const mine = queue.body.data.filter((d) => d.claim_id === id)
    expect(mine).toHaveLength(3)
    for (const doc of mine) expectOk(await raj.post(`/documents/${doc.id}/review`, { decision: 'ACCEPT' }))
    expectOk(await raj.post(`/claims/${id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' }))

    // Triage and assignment
    expectOk(await maria.post(`/claims/${id}/assignments`, { assigneeId: await ctx.userId('adjuster.adam'), assignmentRole: 'ADJUSTER' }), 201)

    // Investigation, evaluation and reserve (within adjuster authority -> posted)
    const evaluation = await adam.post(`/claims/${id}/evaluations`, {
      checklist: { SITE_INSPECTION: true, STATEMENTS_COLLECTED: true, EVIDENCE_REVIEWED: true, COVERAGE_ANALYSIS: true, FRAUD_INDICATORS: true },
      findings: 'Damage consistent with rear-end collision; repair estimate verified with approved garage.',
      lossValue: 2400,
      liabilityPct: 0,
      recommendedSettlement: 1900,
      decision: 'PAY_PARTIAL',
      internalNotes: 'Deductible of 500 applied.',
    })
    expectOk(evaluation, 201)
    const evaluated = await adam.post(`/evaluations/${evaluation.body.data.id}/submit`, { reserveAmount: 2000, reserveReason: 'Repair plus contingency' })
    expectOk(evaluated)
    expect(evaluated.body.data.reserve.approval_status).toBe('POSTED')
    expect(evaluated.body.data.claim.status).toBe('COMPLIANCE_REVIEW')

    // Compliance clearance prepares the settlement
    const review = (await carlos.get(`/claims/${id}/compliance-reviews`)).body.data[0]
    expectOk(await carlos.patch(`/compliance-reviews/${review.id}`, { checklist: { SANCTIONS_SCREENING: true, AML_CHECK: true, KYC_VERIFIED: true, FRAUD_SCORE_REVIEWED: true, CONFLICT_OF_INTEREST: true } }))
    const cleared = await carlos.post(`/compliance-reviews/${review.id}/decision`, { decision: 'CLEAR', notes: 'No concerns' })
    expectOk(cleared)
    expect(cleared.body.data.settlement.amount).toBe(1900)

    // Settlement within the adjuster's authority: the assigned adjuster approves, a Payment Operator issues
    expectOk(await adam.post(`/settlements/${cleared.body.data.settlement.id}/approvals`, { decision: 'APPROVED' }))
    const issued = await priya.post(`/payments/${cleared.body.data.settlement.id}/issue`, {}, { 'Idempotency-Key': `e2e-${uniqueKey()}` })
    expectOk(issued)
    expect(issued.body.data.payment.status).toBe('PAID')

    // Closure: adjuster requests, Claims Manager decides
    const request = await adam.post(`/claims/${id}/closure-requests`, { reason: 'Paid in full; no recovery potential identified.' })
    expectOk(request, 201)
    const closed = await maria.post(`/closure-requests/${request.body.data.id}/decision`, { decision: 'APPROVED', comment: 'File complete' })
    expectOk(closed)
    expect(closed.body.data.claim.status).toBe('CLOSED')
    expect(closed.body.data.claim.stage).toBe('CLOSURE')

    // Reserve ledger: 2000 posted, reduced by the 1900 payment, remainder released at closure
    const ledger = await ctx.db.findMany('reserves', { where: { claim_id: id }, orderBy: [['created_at', 'asc']] })
    expect(ledger.map((r) => [r.reason_code, r.amount])).toEqual([['INITIAL', 2000], ['PAYMENT_ISSUED', 100], ['CLOSURE_RELEASE', 0]])
    // Every stage clock stopped; the acknowledgement clock met its target.
    expect(await ctx.db.count('sla_clocks', { claim_id: id, stopped_at: null })).toBe(0)
    const ack = await ctx.db.findOne('sla_clocks', { claim_id: id, clock_type: 'ACKNOWLEDGE' })
    expect(new Date(ack.stopped_at) <= new Date(ack.due_at)).toBe(true)
    // Reverse reviews recorded the closure decision.
    expect(await ctx.db.count('reviews', { claim_id: id, checkpoint_type: 'CLOSURE', outcome: 'APPROVED' })).toBe(1)

    // Client view of the outcome
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
      'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAID', 'CLOSED',
    ])

    // The tamper-evident audit chain is intact after the whole lifecycle.
    const chain = await carlos.get('/audit-logs/verify')
    expectOk(chain)
    expect(chain.body.data.intact).toBe(true)
  })
})
