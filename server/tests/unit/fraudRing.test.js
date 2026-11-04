import { describe, expect, it } from 'vitest'
import { detectWorkspaceProvider, normalizeAddress, premisesSimilarity } from '../../src/services/intelligence/addressNormalizer.js'
import { scoreRing } from '../../src/services/intelligence/fraudRing.service.js'

describe('address normalisation', () => {
  it('matches the same building across spelling, order and unit differences', () => {
    const a = normalizeAddress('Suite 101, 5th Floor, Prestige Towers, M.G. Road, Bengaluru - 560 001')
    const b = normalizeAddress('Prestige Tower, 2nd Flr, Unit 204, MG Rd, Bangalore 560001')
    expect(a.premisesHash).toBe(b.premisesHash)
    // The unit is what differs, and it is kept out of the hash on purpose.
    expect(a.unitLabel).toMatch(/101/)
    expect(b.unitLabel).toMatch(/204/)
    expect(a.pincode).toBe('560001')
  })

  it('does not collapse genuinely different buildings', () => {
    const a = normalizeAddress('Prestige Towers, MG Road, Bangalore 560001')
    const b = normalizeAddress('Embassy Tower, MG Road, Bangalore 560001')
    expect(a.premisesHash).not.toBe(b.premisesHash)
  })

  it('strips corporate suffixes that travel with the entity, not the building', () => {
    const a = normalizeAddress('Alpha Trading Pvt Ltd, Regus, Cyber Towers, Hitech City, Hyderabad 500081', { entityName: 'Alpha Trading Pvt Ltd' })
    const b = normalizeAddress('Beta Exports Private Limited, Regus, Cyber Tower, Hitech City, Hyderabad 500081', { entityName: 'Beta Exports Private Limited' })
    expect(a.premisesHash).toBe(b.premisesHash)
    expect(a.workspaceProvider).toBe('REGUS')
  })

  it('flags co-working providers and refuses to hash a too-thin address', () => {
    expect(detectWorkspaceProvider('WeWork Galaxy, Residency Road')).toBe('WEWORK')
    expect(detectWorkspaceProvider('91Springboard, Koramangala')).toBe('91SPRINGBOARD')
    expect(detectWorkspaceProvider('Plot 42, Industrial Estate')).toBeNull()
    expect(normalizeAddress('Mumbai').premisesHash).toBeNull()
    expect(normalizeAddress('').premisesHash).toBeNull()
  })

  it('scores near-misses for human confirmation', () => {
    const a = normalizeAddress('Prestige Towers, MG Road, Bangalore 560001')
    const b = normalizeAddress('Prestige Towers, MG Road, Bangalore')
    expect(a.premisesHash).not.toBe(b.premisesHash)
    expect(premisesSimilarity(a, b)).toBeGreaterThan(0.8)
  })
})

const premisesAt = (hash, entityIds, extra = {}) =>
  entityIds.map((entity_id) => ({ entity_id, premises_hash: hash, is_shared_workspace: false, workspace_provider: null, ...extra }))

describe('ring scoring', () => {
  it('holds honest co-working tenants at LOW without corroboration', () => {
    const out = scoreRing({
      entityIds: ['a', 'b', 'c'],
      premises: premisesAt('h1', ['a', 'b', 'c'], { is_shared_workspace: true, workspace_provider: 'WEWORK' }),
      verifications: [],
      sharedBankAccounts: 0,
      claims: [
        { entity_id: 'a', opened_at: '2026-01-10', loss_date: '2026-01-05', effective_from: '2024-01-01', prior_claims: 2 },
        { entity_id: 'b', opened_at: '2026-06-20', loss_date: '2026-06-15', effective_from: '2023-05-01', prior_claims: 1 },
      ],
    })
    expect(out.corroborated).toBe(false)
    expect(out.band).toBe('LOW')
    expect(out.score).toBeLessThan(30)
  })

  it('escalates when a site visit finds no office', () => {
    const out = scoreRing({
      entityIds: ['a', 'b'],
      premises: premisesAt('h1', ['a', 'b'], { is_shared_workspace: true, workspace_provider: 'REGUS' }),
      verifications: [{ entity_id: 'a', outcome: 'NOT_FOUND' }, { entity_id: 'b', outcome: 'OCCUPANT_DENIES' }],
      sharedBankAccounts: 0,
      claims: [
        { entity_id: 'a', opened_at: '2026-03-01', loss_date: '2026-02-20', effective_from: '2026-01-15', prior_claims: 0 },
        { entity_id: 'b', opened_at: '2026-03-20', loss_date: '2026-03-10', effective_from: '2026-02-01', prior_claims: 0 },
      ],
    })
    expect(out.corroborated).toBe(true)
    expect(out.band).toBe('CRITICAL')
    const codes = out.signals.map((s) => s.code)
    expect(codes).toContain('PREMISES_NOT_FOUND')
    expect(codes).toContain('RAPID_CLAIM_AFTER_INCEPTION')
    expect(codes).toContain('CORRELATED_RING_TIMING')
    expect(codes).toContain('NO_TRADING_HISTORY')
  })

  it('escalates on a shared bank account even when the address looks ordinary', () => {
    const out = scoreRing({
      entityIds: ['a', 'b'],
      premises: premisesAt('h1', ['a', 'b']),
      verifications: [],
      sharedBankAccounts: 1,
      claims: [
        { entity_id: 'a', opened_at: '2026-04-01', loss_date: '2026-03-28', effective_from: '2022-01-01', prior_claims: 3 },
        { entity_id: 'b', opened_at: '2026-09-01', loss_date: '2026-08-28', effective_from: '2021-01-01', prior_claims: 5 },
      ],
    })
    expect(out.corroborated).toBe(true)
    expect(out.score).toBeGreaterThanOrEqual(55)
    expect(out.signals.map((s) => s.code)).toContain('SHARED_BANK_ACCOUNT')
  })

  it('stays silent when nothing is shared', () => {
    const out = scoreRing({
      entityIds: ['a', 'b'],
      premises: [
        { entity_id: 'a', premises_hash: 'h1', is_shared_workspace: false, workspace_provider: null },
        { entity_id: 'b', premises_hash: 'h2', is_shared_workspace: false, workspace_provider: null },
      ],
      verifications: [],
      sharedBankAccounts: 0,
      claims: [{ entity_id: 'a', opened_at: '2026-01-01', loss_date: '2025-12-20', effective_from: '2020-01-01', prior_claims: 4 }],
    })
    expect(out.signals).toHaveLength(0)
    expect(out.score).toBe(0)
  })
})
