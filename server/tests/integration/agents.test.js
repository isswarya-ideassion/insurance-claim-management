import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
let disabledProvider
beforeAll(async () => {
  ctx = await createTestContext()
  disabledProvider = ctx.deps.ai
})
afterAll(() => ctx.close())
afterEach(() => {
  ctx.deps.ai = disabledProvider
})

/** Test double for the provider; the server has no mock-AI mode. */
function useFakeAi(output) {
  ctx.deps.ai = { name: 'test-double', model: 'test-model', configured: true, generateJson: vi.fn(async () => ({ data: typeof output === 'function' ? output() : output, model: 'test-model', usage: {} })) }
  return ctx.deps.ai
}

const run = (who, claimId, agent) => ctx.as(who).post(`/claims/${claimId}/agents/${agent}`)
const apply = (who, runId, body = {}) => ctx.as(who).post(`/agent-runs/${runId}/apply`, body)

describe('claim agents: access and safety', () => {
  it('explains how to configure AI when no provider is set', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const res = await run('ops.olivia', claim.id, 'coverage-checker')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED')
    expect(JSON.stringify(res.body.error.details)).toMatch(/ollama/i)
  })

  it('lets only the roles in the PRD run each agent', async () => {
    useFakeAi({})
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    expect((await run('reviewer.raj', claim.id, 'triage-router')).status).toBe(403)
    expect((await run('payments.priya', claim.id, 'reserve-recommender')).status).toBe(403)
    expect((await run('customer.alice', claim.id, 'coverage-checker')).status).toBe(403)
    expect((await run('ops.olivia', claim.id, 'no-such-agent')).status).toBe(422)
  })

  it('records a failed run when the model output does not match the schema', async () => {
    useFakeAi({ nonsense: true })
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const res = await run('ops.olivia', claim.id, 'coverage-checker')
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_INVALID_OUTPUT')
    expect(await ctx.db.count('ai_runs', { claim_id: claim.id, agent: 'coverage-checker', status: 'FAILED' })).toBe(1)
  })
})

describe('coverage checker', () => {
  it('suggests a result with clause citations, which a claims officer records as the coverage decision', async () => {
    const ai = useFakeAi({
      result: 'COVERED',
      covering_clause_ids: ['COV-1', 'COV-99'],
      exclusion_clause_ids: [],
      matched_perils: ['Third party liability'],
      applicable_limit: 500000,
      deductible: 1000,
      rationale: 'The liability cover applies to injury to a member of the public at the insured premises.',
      confidence: 0.86,
      needs_human: false,
    })
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const res = await run('ops.olivia', claim.id, 'coverage-checker')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const out = res.body.data.run.result
    expect(out.coveringClauses.map((c) => c.id)).toEqual(['COV-1'])
    expect(out.checkerNotes.join(' ')).toMatch(/do not exist/)
    // The prompt carries numbered clauses and no customer names.
    const sent = ai.generateJson.mock.calls[0][0].content[0].text
    expect(sent).toContain('COV-1')
    expect(sent).not.toContain('Chen Wei')

    const applied = await apply('ops.olivia', res.body.data.run.id, {})
    expect(applied.status, JSON.stringify(applied.body)).toBe(200)
    expect(applied.body.data.human_decision).toBe('ACCEPTED')
    const coverage = await ctx.db.findOne('coverage_results', { claim_id: claim.id, ai_run_ref: res.body.data.run.id })
    expect(coverage).toMatchObject({ result: 'COVERED' })
    expect((await apply('ops.olivia', res.body.data.run.id, {})).status).toBe(409)
  })
})

describe('triage router', () => {
  const triage = () => ({
    severity: 'MEDIUM',
    complexity: 2,
    fraud_score: 42,
    fraud_reasons: [
      { code: 'LATE_NOTIFICATION', severity: 'MEDIUM', explanation: 'Reported several weeks after the loss.' },
      { code: 'MADE_UP_CODE', severity: 'HIGH', explanation: 'Not in the taxonomy.' },
    ],
    recommended_adjuster: 'A1',
    routing_reason: 'Lowest open workload and motor experience.',
    rationale: 'Moderate collision claim with complete documents.',
    confidence: 0.7,
  })

  it('classifies, scores and routes; the score is masked for adjusters and the parts are applied by the right roles', async () => {
    useFakeAi(triage)
    const claim = await ctx.claimByNumber('HPC-2026-000105')
    // A Claims Manager sees the full fraud score and reasons.
    const res = await run('manager.maria', claim.id, 'triage-router')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const out = res.body.data.run.result
    expect(out.fraudReasons.map((r) => r.code)).toEqual(['LATE_NOTIFICATION'])
    expect(out.recommendedAdjuster).toMatchObject({ name: expect.any(String) })
    const runId = res.body.data.run.id

    // Claims Operations Managers see the band only; Compliance & Security see the score.
    const asOps = await ctx.as('ops.olivia').get(`/claims/${claim.id}/agents/triage-router`)
    expect(asOps.body.data.runs[0].result.fraudScore).toBeUndefined()
    expect(asOps.body.data.runs[0].result.fraudBand).toBe('MEDIUM')
    const asCompliance = await ctx.as('compliance.carlos').get(`/claims/${claim.id}/agents/triage-router`)
    expect(asCompliance.body.data.runs[0].result.fraudScore).toBe(42)

    const ok = await apply('ops.olivia', runId, { parts: ['classification', 'adjuster'] })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const updated = await ctx.claimByNumber('HPC-2026-000105')
    expect(updated).toMatchObject({ severity: 'MEDIUM', complexity: 2, assigned_adjuster_id: out.recommendedAdjuster.id, status: 'INVESTIGATION' })

    // Fraud flags need compliance authority.
    expect((await apply('ops.olivia', runId, { parts: ['fraud_flags'] })).status).toBe(403)
    const flags = await apply('compliance.carlos', runId, { parts: ['fraud_flags'] })
    expect(flags.status, JSON.stringify(flags.body)).toBe(200)
    expect(await ctx.db.count('claim_fraud_flags', { claim_id: claim.id, ai_run_ref: runId })).toBe(1)
    expect(flags.body.data.applied_fields.sort()).toEqual(['adjuster', 'classification', 'fraud_flags'])
    expect((await apply('compliance.carlos', runId, { parts: ['fraud_flags'] })).body.error.code).toBe('ALREADY_APPLIED')
  })
})

describe('reserve recommender', () => {
  it('lets the assigned adjuster accept a recommended reserve; overrides need a reason', async () => {
    useFakeAi({
      lines: [
        { coverage_line: 'OWN_DAMAGE', low: 9000, point: 10500, high: 12000, drivers: ['Repair estimate', 'Comparable claims'] },
        { coverage_line: 'NOT_A_LINE', low: 1, point: 2, high: 3, drivers: [] },
      ],
      comparables_used: ['K1'],
      rationale: 'Repair estimate is in line with settled theft claims.',
      confidence: 0.75,
    })
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    expect((await run('adjuster.amara', claim.id, 'reserve-recommender')).status).toBe(404)
    const res = await run('adjuster.adam', claim.id, 'reserve-recommender')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.run.result.lines.map((l) => l.coverageLine)).toEqual(['OWN_DAMAGE'])

    const runId = res.body.data.run.id
    const noReason = await apply('adjuster.adam', runId, { coverageLine: 'OWN_DAMAGE', amount: 11000 })
    expect(noReason.status).toBe(422)
    const ok = await apply('adjuster.adam', runId, { coverageLine: 'OWN_DAMAGE', amount: 10500 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await ctx.db.findOne('reserves', { claim_id: claim.id, ai_run_ref: runId })).toMatchObject({ reason_code: 'AI_RECOMMENDATION_ACCEPTED', amount: 10500, approval_status: 'POSTED' })
  })
})

describe('denial letter drafter', () => {
  it('drafts only when denial is on the table; a Claims Manager approves the edited letter as a PDF on the claim', async () => {
    useFakeAi({
      subject: 'Your claim {{CLAIM_NUMBER}}',
      body: 'Dear {{CLAIMANT_NAME}},\n\nWe have reviewed claim {{CLAIM_NUMBER}} under policy {{POLICY_NUMBER}}. The loss is not covered under clause COV-1 because the damage arose from wear and tear, which the policy does not cover.\n\nYours sincerely,\nHarborPoint Claims',
      cited_clause_ids: ['COV-1'],
      facts_relied_on: ['Evaluation findings'],
      missing_notice_language: [],
      confidence: 0.7,
    })
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    expect((await run('adjuster.adam', claim.id, 'denial-letter-drafter')).body.error.code).toBe('NO_DENIAL_BASIS')
    await ctx.db.update('claims', { id: claim.id }, { coverage_result: 'NOT_COVERED' })

    const res = await run('adjuster.adam', claim.id, 'denial-letter-drafter')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    // The draft has no review or grievance wording, so both are flagged.
    expect(res.body.data.run.result.missingNoticeLanguage.join(' ')).toMatch(/reviewed.*grievance|grievance/s)

    const runId = res.body.data.run.id
    expect((await apply('adjuster.adam', runId, { subject: 'x'.repeat(10), body: 'y'.repeat(120) })).status).toBe(403)
    const edited = `${res.body.data.run.result.body}\n\nYou may ask us to review this decision, or raise a grievance with our grievance officer.`
    const ok = await apply('manager.maria', runId, { subject: res.body.data.run.result.subject, body: edited })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    const doc = await ctx.db.findOne('documents', { claim_id: claim.id, doc_type: 'DENIAL_LETTER' })
    expect(doc).toMatchObject({ status: 'ACCEPTED', mime_type: 'application/pdf' })
    const bytes = await ctx.deps.storage.get(doc.storage_key)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.toString('latin1')).toContain(claim.claim_number)
    // The claim itself is not denied by approving a letter.
    expect((await ctx.claimByNumber('HPC-2026-000106')).status).toBe('INVESTIGATION')
  })
})

describe('payee anomaly check', () => {
  it('flags anomalies with approved codes and hands the draft request to the payments team', async () => {
    useFakeAi({
      anomalies: [
        { code: 'RECENT_BANK_CHANGE', evidence: 'Bank details changed recently.', draft_request: 'Please confirm the new account with a cancelled cheque.' },
        { code: 'NOT_A_CODE', evidence: 'x', draft_request: 'y' },
      ],
      summary: 'One item to confirm with the payee.',
      confidence: 0.8,
    })
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const res = await run('payments.priya', claim.id, 'payee-anomaly')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const out = res.body.data.run.result
    expect(out.anomalies.map((a) => a.code)).toEqual(['RECENT_BANK_CHANGE'])
    expect(out.payee.account).toMatch(/^•••• \d{4}$/)

    const ok = await apply('payments.priya', res.body.data.run.id, { createTask: true })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await ctx.db.findOne('tasks', { claim_id: claim.id, owner_role: 'PAYMENT_OPERATOR', type: 'PAYMENT' })).toMatchObject({ status: 'OPEN' })
    // Nothing about the payment changed.
    expect((await ctx.db.findOne('payments', { claim_id: claim.id })).status).toBe('PENDING_APPROVAL')
  })

  it('discards output that concludes fraud or advises on releasing the payment', async () => {
    useFakeAi({ anomalies: [], summary: 'This looks like fraud; block the payment.', confidence: 0.9 })
    const claim = await ctx.claimByNumber('HPC-2026-000111')
    const res = await run('payments.priya', claim.id, 'payee-anomaly')
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('AI_POLICY_VIOLATION')
  })
})

describe('subrogation assessor', () => {
  it('assesses recovery and creates a recovery record, capped at the amount paid', async () => {
    useFakeAi({
      recovery_likelihood: 'MEDIUM',
      recommended_type: 'SUBROGATION',
      third_parties: [{ party: 'Tour operator', basis: 'Unused excursions were prepaid', evidence: 'Booking invoice' }],
      salvage_items: [],
      limitation_deadline: '2029-09-01',
      referral_by: '2030-01-01',
      rationale: 'The tour operator owes a partial refund.',
      confidence: 0.6,
    })
    const claim = await ctx.claimByNumber('HPC-2026-000114')
    const res = await run('adjuster.amara', claim.id, 'subrogation-assessor')
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const out = res.body.data.run.result
    expect(out.referralBy).toBe('2029-09-01')

    const runId = res.body.data.run.id
    expect((await apply('adjuster.amara', runId, { type: 'SUBROGATION', expectedAmount: 999999 })).status).toBe(422)
    const ok = await apply('adjuster.amara', runId, { type: 'SUBROGATION', expectedAmount: 400 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await ctx.db.findOne('recoveries', { claim_id: claim.id, ai_run_ref: runId })).toMatchObject({ type: 'SUBROGATION', target_party: 'Tour operator', expected_amount: 400 })
  })

  it('lets a reviewer discard a suggestion instead of applying it', async () => {
    useFakeAi({ recovery_likelihood: 'LOW', recommended_type: 'NONE', third_parties: [], salvage_items: [], limitation_deadline: null, referral_by: null, rationale: 'No liable third party.', confidence: 0.5 })
    const claim = await ctx.claimByNumber('HPC-2026-000114')
    const res = await run('adjuster.amara', claim.id, 'subrogation-assessor')
    const discarded = await ctx.as('adjuster.amara').post(`/agent-runs/${res.body.data.run.id}/discard`, { reason: 'Agree, nothing to recover' })
    expect(discarded.status).toBe(200)
    expect(discarded.body.data.human_decision).toBe('REJECTED')
  })
})
