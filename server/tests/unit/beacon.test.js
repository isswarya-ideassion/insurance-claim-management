import { describe, expect, it } from 'vitest'
import { createAiProvider } from '../../src/services/ai.service.js'
import { BEACON_AGENTS } from '../../src/services/intelligence/beacon.provider.js'
import { AI_AGENTS, PAYEE_ANOMALY_CODES } from '../../../shared/constants.js'

const beacon = createAiProvider({ AI_PROVIDER: 'beacon' })
const run = (agent, input) => beacon.generateJson({ agent, input }).then((r) => r.data)

describe('Beacon provider', () => {
  it('reports itself as configured, so the UI stops asking for a model', () => {
    expect(beacon.name).toBe('beacon')
    expect(beacon.configured).toBe(true)
    expect(BEACON_AGENTS).toHaveLength(6)
  })

  it('refuses agents that need to read free text instead of faking an answer', async () => {
    await expect(beacon.generateJson({ agent: AI_AGENTS.CLAIM_SUMMARIZER, input: {} })).rejects.toMatchObject({
      code: 'AI_AGENT_UNSUPPORTED',
    })
  })
})

describe('coverage check', () => {
  const policy = {
    sum_insured: 900_000,
    deductible: 5_000,
    clauses: [
      { id: 'COV-1', type: 'COVERAGE', text: 'Accidental fire damage to insured premises' },
      { id: 'COV-2', type: 'COVERAGE', text: 'Burglary following forcible entry' },
      { id: 'EXC-1', type: 'EXCLUSION', text: 'Loss caused by flood or inundation' },
    ],
  }

  it('matches the covering clause for a fire loss', async () => {
    const out = await run(AI_AGENTS.COVERAGE_CHECKER, {
      loss: { claim_type: 'PROPERTY', loss_type: 'FIRE' },
      policy,
      hard_checks: { passed: true, failed_reasons: [] },
    })
    expect(out.result).toBe('COVERED')
    expect(out.covering_clause_ids).toContain('COV-1')
    expect(out.deductible).toBe(5_000)
  })

  it('picks up the exclusion for a flood loss', async () => {
    const out = await run(AI_AGENTS.COVERAGE_CHECKER, {
      loss: { claim_type: 'PROPERTY', loss_type: 'FLOOD' },
      policy,
      hard_checks: { passed: true, failed_reasons: [] },
    })
    expect(out.result).toBe('NOT_COVERED')
    expect(out.exclusion_clause_ids).toContain('EXC-1')
  })

  it('never contradicts a failed policy check, and never claims high confidence', async () => {
    const out = await run(AI_AGENTS.COVERAGE_CHECKER, {
      loss: { claim_type: 'PROPERTY', loss_type: 'FIRE' },
      policy,
      hard_checks: { passed: false, failed_reasons: ['Policy lapsed on the loss date'] },
    })
    expect(out.result).toBe('NEEDS_REVIEW')
    // Below the agent's 0.8 bar, so a person always reviews a coverage call.
    expect(out.confidence).toBeLessThan(0.8)
    expect(out.needs_human).toBe(true)
  })
})

describe('triage', () => {
  const taxonomy = [
    { code: 'LATE_NOTIFICATION', description: 'late', weight: 15 },
    { code: 'DUPLICATE_SUSPECTED', description: 'dup', weight: 35 },
    { code: 'HIGH_VALUE', description: 'high', weight: 10 },
    { code: 'RAPID_CLAIM_AFTER_INCEPTION', description: 'rapid', weight: 25 },
    { code: 'NO_TRADING_HISTORY', description: 'none', weight: 10 },
  ]
  const base = {
    loss: { claim_type: 'MOTOR', loss_type: 'COLLISION', estimated_loss: 80_000, days_from_loss_to_report: 2, loss_date: '2026-06-01' },
    policy: { sum_insured: 900_000, effective_date: '2024-01-01' },
    prior_claims_on_policy_24_months: ['CLOSED', 'PAID'],
    possible_duplicate: false,
    documents: [],
    severity_thresholds: { LOW: 0, MEDIUM: 50_000, HIGH: 500_000, CATASTROPHIC: 2_000_000 },
    fraud_reason_taxonomy: taxonomy,
    candidate_adjusters: [
      { alias: 'A1', open_claims: 9, high_priority_open: 2, claims_handled_by_type: { MOTOR: 12 } },
      { alias: 'A2', open_claims: 2, high_priority_open: 0, claims_handled_by_type: { HEALTH: 5 } },
    ],
  }

  it('bands severity from the segment thresholds', async () => {
    expect((await run(AI_AGENTS.TRIAGE_ROUTER, base)).severity).toBe('MEDIUM')
    const large = { ...base, loss: { ...base.loss, estimated_loss: 600_000 } }
    expect((await run(AI_AGENTS.TRIAGE_ROUTER, large)).severity).toBe('HIGH')
  })

  it('scores a clean claim low and a suspicious one high', async () => {
    const clean = await run(AI_AGENTS.TRIAGE_ROUTER, base)
    expect(clean.fraud_score).toBe(0)

    const suspicious = await run(AI_AGENTS.TRIAGE_ROUTER, {
      ...base,
      loss: { ...base.loss, days_from_loss_to_report: 120, estimated_loss: 800_000 },
      policy: { sum_insured: 900_000, effective_date: '2026-05-10' },
      possible_duplicate: true,
      prior_claims_on_policy_24_months: [],
    })
    expect(suspicious.fraud_score).toBeGreaterThan(50)
    const codes = suspicious.fraud_reasons.map((r) => r.code)
    expect(codes).toContain('LATE_NOTIFICATION')
    expect(codes).toContain('DUPLICATE_SUSPECTED')
    expect(codes).toContain('RAPID_CLAIM_AFTER_INCEPTION')
  })

  it('only ever returns reason codes the database holds', async () => {
    const out = await run(AI_AGENTS.TRIAGE_ROUTER, {
      ...base,
      possible_duplicate: true,
      fraud_reason_taxonomy: [{ code: 'LATE_NOTIFICATION', weight: 15 }],
    })
    for (const reason of out.fraud_reasons) expect(reason.code).toBe('LATE_NOTIFICATION')
  })

  it('routes on experience first, then workload', async () => {
    const out = await run(AI_AGENTS.TRIAGE_ROUTER, base)
    expect(out.recommended_adjuster).toBe('A1') // handled 12 motor claims
    const health = { ...base, loss: { ...base.loss, claim_type: 'HEALTH' } }
    expect((await run(AI_AGENTS.TRIAGE_ROUTER, health)).recommended_adjuster).toBe('A2')
  })

  it('is reproducible — the same claim always triages the same way', async () => {
    const a = await run(AI_AGENTS.TRIAGE_ROUTER, base)
    const b = await run(AI_AGENTS.TRIAGE_ROUTER, base)
    expect(a).toEqual(b)
  })
})

describe('reserve recommendation', () => {
  it('takes the range from the quantiles of comparable settlements', async () => {
    const out = await run(AI_AGENTS.RESERVE_RECOMMENDER, {
      loss: { claim_type: 'MOTOR', estimated_loss: 100_000 },
      coverage_lines: ['OWN_DAMAGE'],
      comparable_settled_claims: [40_000, 60_000, 80_000, 100_000, 120_000].map((paid, i) => ({ alias: `K${i + 1}`, paid })),
    })
    const line = out.lines[0]
    expect(line.point).toBe(80_000) // median
    expect(line.low).toBeLessThan(line.point)
    expect(line.high).toBeGreaterThan(line.point)
    expect(out.comparables_used.length).toBe(5)
  })

  it('says so plainly when there are too few comparables to form a range', async () => {
    const out = await run(AI_AGENTS.RESERVE_RECOMMENDER, {
      loss: { claim_type: 'TRAVEL', estimated_loss: 50_000 },
      coverage_lines: ['TRIP_CANCELLATION'],
      comparable_settled_claims: [{ alias: 'K1', paid: 48_000 }],
    })
    expect(out.confidence).toBeLessThan(0.5)
    expect(out.rationale).toMatch(/too few/i)
    expect(out.comparables_used).toHaveLength(0)
  })
})

describe('payee anomaly check', () => {
  const input = {
    payee: { name: 'Northwind Trading', type: 'BUSINESS' },
    insured_name: 'Ramesh Kumar',
    claimant_name: 'Ramesh Kumar',
    payee_belongs_to_policyholder: false,
    prior_payments_to_payee: 0,
    bank_changed_after_last_payment: false,
    days_since_bank_change: 3,
    other_payees_with_same_account: 1,
    other_claims_paying_this_payee: 2,
    approved_codes: PAYEE_ANOMALY_CODES,
  }

  it('reproduces every deterministic signal without a model', async () => {
    const out = await run(AI_AGENTS.PAYEE_ANOMALY, input)
    const codes = out.anomalies.map((a) => a.code)
    expect(codes).toContain('NEW_BANK_DETAILS')
    expect(codes).toContain('RECENT_BANK_CHANGE')
    expect(codes).toContain('DUPLICATE_PAYEE')
    expect(codes).toContain('PAYEE_ON_MULTIPLE_CLAIMS')
    expect(codes).toContain('THIRD_PARTY_PAYEE')
    expect(codes).toContain('NAME_MISMATCH')
    expect(out.confidence).toBeGreaterThan(0.9)
  })

  it('stays silent on a clean payee', async () => {
    const out = await run(AI_AGENTS.PAYEE_ANOMALY, {
      ...input,
      payee: { name: 'Ramesh Kumar' },
      payee_belongs_to_policyholder: true,
      prior_payments_to_payee: 4,
      days_since_bank_change: 900,
      other_payees_with_same_account: 0,
      other_claims_paying_this_payee: 0,
    })
    expect(out.anomalies).toHaveLength(0)
    expect(out.summary).toMatch(/nothing needs confirming/i)
  })

  it('never draws a fraud conclusion or touches the payment — the agent discards output that does', async () => {
    const out = await run(AI_AGENTS.PAYEE_ANOMALY, input)
    const forbidden = /\bfraud(ulent|ster)?\b|\b(release|block|hold|stop|withhold)\s+(the\s+)?payment\b/i
    for (const text of [out.summary, ...out.anomalies.flatMap((a) => [a.evidence, a.draft_request])]) {
      expect(forbidden.test(text)).toBe(false)
    }
  })
})

describe('denial letter', () => {
  it('produces a letter carrying the notices the agent requires', async () => {
    const out = await run(AI_AGENTS.DENIAL_DRAFTER, {
      loss: { claim_type: 'PROPERTY', loss_type: 'FLOOD', loss_date: '2026-07-02' },
      evaluation: { decision: 'DENY', findings: 'the loss arose from inundation' },
      coverage_results: [{ result: 'NOT_COVERED', notes: 'flood exclusion applies' }],
      policy_clauses: [{ id: 'EXC-1', type: 'EXCLUSION', text: 'Loss caused by flood or inundation' }],
    })
    // NOTICE_CHECKS in agents.service.js require both of these.
    expect(out.body).toMatch(/\b(review|reconsider|appeal)\b/i)
    expect(out.body).toMatch(/\b(grievance|complaint|ombudsman)\b/i)
    expect(out.cited_clause_ids).toContain('EXC-1')
    // Only the approved placeholders — any other token is rejected on apply.
    const placeholders = [...out.body.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
    for (const p of placeholders) expect(['CLAIMANT_NAME', 'CLAIM_NUMBER', 'POLICY_NUMBER', 'DATE']).toContain(p)
  })
})

describe('subrogation assessment', () => {
  it('derives the limitation deadline from the supplied jurisdiction table', async () => {
    const out = await run(AI_AGENTS.SUBROGATION_ASSESSOR, {
      loss: { claim_type: 'MOTOR', loss_date: '2026-03-14', affected_asset: 'Tata Ace' },
      other_parties: [{ party_type: 'THIRD_PARTY', name: 'Speedy Logistics', role_in_loss: 'Rear-ended the insured vehicle' }],
      documents_on_file: ['POLICE_REPORT'],
      amount_paid: 240_000,
      jurisdiction_table: [{ jurisdiction: 'India', years: 3 }],
      today: '2026-10-29',
    })
    expect(out.limitation_deadline).toBe('2029-03-14')
    expect(out.referral_by < out.limitation_deadline).toBe(true)
    expect(out.recovery_likelihood).toBe('HIGH')
    expect(out.recommended_type).toBe('SUBROGATION')
    expect(out.third_parties[0].party).toBe('Speedy Logistics')
  })

  it('reports no recovery route when there is no third party', async () => {
    const out = await run(AI_AGENTS.SUBROGATION_ASSESSOR, {
      loss: { claim_type: 'HEALTH', loss_date: '2026-03-14' },
      other_parties: [],
      documents_on_file: [],
      amount_paid: 0,
      jurisdiction_table: [{ jurisdiction: 'India', years: 3 }],
    })
    expect(out.recovery_likelihood).toBe('LOW')
    expect(out.recommended_type).toBe('NONE')
  })
})
