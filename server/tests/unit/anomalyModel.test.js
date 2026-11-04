import { describe, expect, it } from 'vitest'
import { anomalyScore, explainScore, trainIsolationForest } from '../../src/services/intelligence/isolationForest.js'
import { buildPopulationStats, featureMedians, featureNames, toVector } from '../../src/services/intelligence/features.js'

/**
 * A synthetic Indian motor/health book: ordinary claims reported within a few
 * days, modest amounts against the sum insured, awkward invoice-built figures.
 * Fraud-shaped claims are then planted and the model must rank them top
 * WITHOUT ever being told which is which — that is the whole point of training
 * unsupervised.
 */
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString()

function ordinaryClaim(i) {
  const lossDay = 40 + (i % 200)
  return {
    claim_type: i % 2 ? 'MOTOR' : 'HEALTH',
    loss_date: day(lossDay),
    opened_at: day(lossDay + 1 + (i % 3)),
    effective_date: day(lossDay - 300 - (i % 60)),
    expiry_date: day(lossDay + 65),
    policy_created_at: day(lossDay - 300 - (i % 60)),
    // Invoice-built figures: never round.
    estimated_loss: 37_480 + ((i * 1373) % 46_000),
    sum_insured: 900_000,
    prior_claims: i % 3,
    document_count: 4 + (i % 3),
    rejected_documents: 0,
    reopen_count: 0,
    escalation_level: 0,
    severity: i % 5 === 0 ? 'MEDIUM' : 'LOW',
    possible_duplicate_of: null,
    entities_at_premises: 1,
  }
}

/** Health claim inside the 30-day initial waiting period, for a round ₹5,00,000. */
const waitingPeriodClaim = {
  claim_type: 'HEALTH',
  loss_date: day(220),
  opened_at: day(221),
  effective_date: day(200),
  expiry_date: day(565),
  policy_created_at: day(200),
  estimated_loss: 500_000,
  sum_insured: 900_000,
  prior_claims: 0,
  document_count: 1,
  rejected_documents: 1,
  reopen_count: 0,
  escalation_level: 0,
  severity: 'HIGH',
  possible_duplicate_of: null,
  entities_at_premises: 1,
}

/** Late intimation, near-total loss, shell entities sharing a building. */
const ringClaim = {
  claim_type: 'MOTOR',
  loss_date: day(150),
  opened_at: day(262),
  effective_date: day(140),
  expiry_date: day(505),
  policy_created_at: day(140),
  estimated_loss: 850_000,
  sum_insured: 900_000,
  prior_claims: 0,
  document_count: 1,
  rejected_documents: 1,
  reopen_count: 2,
  escalation_level: 2,
  severity: 'CATASTROPHIC',
  possible_duplicate_of: 'dup',
  entities_at_premises: 6,
}

function fit(extra = []) {
  const rows = [...Array.from({ length: 300 }, (_, i) => ordinaryClaim(i)), ...extra]
  const stats = buildPopulationStats(rows, { authorityThresholds: [100_000, 500_000, 2_500_000] })
  const vectors = rows.map((r) => toVector(r, stats))
  return { rows, stats, vectors, model: trainIsolationForest(vectors, { trees: 120, seed: 7 }), medians: featureMedians(vectors) }
}

describe('claim anomaly model', () => {
  it('ranks planted fraud-shaped claims above the ordinary book', () => {
    const { stats, model } = fit([waitingPeriodClaim, ringClaim])
    const ordinaryScores = Array.from({ length: 300 }, (_, i) => anomalyScore(model, toVector(ordinaryClaim(i), stats)))
    const typicalMax = Math.max(...ordinaryScores)

    expect(anomalyScore(model, toVector(ringClaim, stats))).toBeGreaterThan(typicalMax)
    expect(anomalyScore(model, toVector(waitingPeriodClaim, stats))).toBeGreaterThan(typicalMax)
  })

  it('holds the alert budget on a book with no planted fraud', () => {
    const { stats, model } = fit()
    const scores = Array.from({ length: 300 }, (_, i) => anomalyScore(model, toVector(ordinaryClaim(i), stats)))
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(0.25)

    // An anomaly detector always has a tail: even a clean book puts a few
    // claims at the edge of its own distribution. What matters operationally
    // is the size of that tail. Above ~5% a reviewer stops reading the queue,
    // which is worse than no model at all.
    const flagged = scores.filter((s) => s >= 0.62).length
    expect(flagged / scores.length).toBeLessThan(0.05)
  })

  it('attributes a score to named features a reviewer can check', () => {
    const { stats, model, medians } = fit([ringClaim])
    const factors = explainScore(model, toVector(ringClaim, stats), medians, featureNames)
    expect(factors.length).toBeGreaterThan(0)
    for (const f of factors) expect(featureNames).toContain(f.feature)
    expect(factors[0].impact).toBeGreaterThan(0)
  })

  it('is reproducible for the same seed and data, and rejects a wrong-width vector', () => {
    const a = fit()
    const b = fit()
    const v = toVector(ringClaim, a.stats)
    expect(anomalyScore(a.model, v)).toBe(anomalyScore(b.model, v))
    expect(() => anomalyScore(a.model, [1, 2, 3])).toThrow(/Expected \d+ features/)
  })
})

describe('Indian policy-term features', () => {
  const stats = buildPopulationStats([], { authorityThresholds: [100_000, 500_000] })
  const value = (row, name) => toVector(row, stats)[featureNames.indexOf(name)]

  it('marks a health claim inside the 30-day initial waiting period', () => {
    expect(value(waitingPeriodClaim, 'within_health_waiting_period')).toBe(1)
    // The same gap on a motor policy carries no waiting period.
    expect(value({ ...waitingPeriodClaim, claim_type: 'MOTOR' }, 'within_health_waiting_period')).toBe(0)
  })

  it('scores invoice-built amounts as less round than fabricated ones', () => {
    expect(value({ estimated_loss: 500_000 }, 'amount_roundness')).toBeGreaterThan(
      value({ estimated_loss: 487_356 }, 'amount_roundness'),
    )
  })

  it('spots an amount parked just under a delegated-authority limit', () => {
    expect(value({ estimated_loss: 96_000 }, 'just_below_authority_limit')).toBe(1)
    expect(value({ estimated_loss: 42_000 }, 'just_below_authority_limit')).toBe(0)
  })

  it('scales intimation delay against the norm for each line of business', () => {
    const late = { claim_type: 'MOTOR', loss_date: day(10), opened_at: day(20) }
    const onTime = { claim_type: 'PROPERTY', loss_date: day(10), opened_at: day(20) }
    // Ten days is a long delay for motor, routine for property.
    expect(value(late, 'intimation_delay_ratio')).toBeGreaterThan(value(onTime, 'intimation_delay_ratio'))
  })

  it('knows the monsoon months, so a seasonal surge is not treated as odd', () => {
    expect(value({ loss_date: day(200) }, 'monsoon_loss')).toBe(1) // 20 July 2026
    expect(value({ loss_date: day(30) }, 'monsoon_loss')).toBe(0) // 31 January 2026
  })
})
