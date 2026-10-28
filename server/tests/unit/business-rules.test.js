import { describe, expect, it } from 'vitest'
import { PERMISSIONS, can, visibleTabs, canSeeTab } from '../../../shared/permissions.js'
import { ROLES, LEGACY_ROLE_MAP, fraudBand, confidenceBand } from '../../../shared/constants.js'
import { evaluatePolicyEligibility } from '../../src/services/eligibility.service.js'
import { createSimulatedPaymentAdapter } from '../../src/services/paymentAdapter.js'
import { createFieldCrypto } from '../../src/services/crypto.service.js'
import { maskFraud } from '../../src/services/presenters.js'
import { buildWhere, buildOrderBy } from '../../src/db/queryBuilder.js'
import { fromDatabaseError } from '../../src/utils/errors.js'
import { maskAccount, maskLast4, sanitizeFileName } from '../../src/utils/format.js'
import { loadConfig } from '../../src/config/env.js'

describe('permissions (PRD authorization matrix)', () => {
  it('maps every former role onto one of the current roles', () => {
    for (const target of Object.values(LEGACY_ROLE_MAP)) expect(Object.values(ROLES)).toContain(target)
    expect(LEGACY_ROLE_MAP.AUDITOR).toBe(ROLES.COMPLIANCE_SECURITY)
    expect(LEGACY_ROLE_MAP.CLAIMS_OPERATIONS).toBe(ROLES.OPS_MANAGER)
  })

  it('keeps the data engineer away from claim decisions and documents', () => {
    const allowed = ['claims.viewQueue', 'tasks.create', 'tasks.update', 'reports.view', 'audit.view', 'config.view', 'integrations.view', 'integrations.manage']
    for (const [perm, roles] of Object.entries(PERMISSIONS)) {
      if (!allowed.includes(perm)) expect(roles, perm).not.toContain(ROLES.DATA_ENGINEER)
    }
    expect(canSeeTab([ROLES.DATA_ENGINEER], 'documents')).toBe(false)
  })

  it('splits financial authority as the PRD describes', () => {
    expect(PERMISSIONS['reserves.set']).toEqual([ROLES.ADJUSTER])
    expect(PERMISSIONS['reserves.review']).toEqual([ROLES.OPS_MANAGER])
    expect(PERMISSIONS['settlements.approve']).toEqual([ROLES.ADJUSTER, ROLES.OPS_MANAGER])
    expect(PERMISSIONS['payments.issue']).toEqual([ROLES.PAYMENT_OPERATOR])
    expect(can([ROLES.ADJUSTER], 'reserves.review')).toBe(false)
  })

  it('gives role administration and customer records to Compliance & Security only', () => {
    expect(PERMISSIONS['admin.users']).toEqual([ROLES.COMPLIANCE_SECURITY])
    expect(PERMISSIONS['customers.view']).toEqual([ROLES.COMPLIANCE_SECURITY])
    expect(PERMISSIONS['audit.viewAll']).toEqual([ROLES.COMPLIANCE_SECURITY])
  })

  it('hides claim tabs by role', () => {
    expect(visibleTabs([ROLES.PAYMENT_OPERATOR])).not.toContain('documents')
    expect(canSeeTab([ROLES.COMPLIANCE_SECURITY], 'compliance')).toBe(true)
    expect(canSeeTab([ROLES.ADJUSTER], 'compliance')).toBe(false)
    expect(visibleTabs([ROLES.CLIENT])).toEqual([])
  })

  it('throws on unknown permissions', () => {
    expect(() => can([ROLES.OPS_MANAGER], 'does.not.exist')).toThrow()
  })
})

describe('fraud governance', () => {
  const claim = { id: 'c1', fraud_score: 72 }
  it('shows the score to managers and compliance, the band to adjusters, nothing to others', () => {
    expect(maskFraud(claim, [ROLES.OPS_MANAGER])).toMatchObject({ fraud_score: 72, fraud_band: 'HIGH' })
    const adjuster = maskFraud(claim, [ROLES.ADJUSTER])
    expect(adjuster.fraud_score).toBeUndefined()
    expect(adjuster.fraud_band).toBe('HIGH')
    expect(maskFraud(claim, [ROLES.DOCUMENT_REVIEWER])).not.toHaveProperty('fraud_band')
  })
  it('bands scores and confidences', () => {
    expect([fraudBand(10), fraudBand(30), fraudBand(60)]).toEqual(['LOW', 'MEDIUM', 'HIGH'])
    expect([confidenceBand(0.2), confidenceBand(0.5), confidenceBand(0.8)]).toEqual(['low', 'medium', 'high'])
  })
})

describe('policy eligibility', () => {
  const policy = {
    insured_id: 'u1',
    status: 'ACTIVE',
    policy_type: 'MOTOR',
    effective_date: '2026-01-01',
    expiry_date: '2026-12-31',
    sum_insured: 40000,
  }

  it('accepts a matching active policy', () => {
    const r = evaluatePolicyEligibility(policy, { customerId: 'u1', lossDate: '2026-06-01T10:00:00Z', claimType: 'MOTOR', lossType: 'COLLISION', estimatedLoss: 1000 })
    expect(r.eligible).toBe(true)
  })

  it('rejects another client’s policy', () => {
    expect(evaluatePolicyEligibility(policy, { customerId: 'u2' }).reasons).toContain('Policy does not belong to the claimant')
  })

  it('rejects lapsed policies, out-of-period losses, wrong types and excessive losses', () => {
    const r = evaluatePolicyEligibility({ ...policy, status: 'LAPSED' }, {
      customerId: 'u1',
      lossDate: '2025-12-30T10:00:00Z',
      claimType: 'HEALTH',
      lossType: 'STORM',
      estimatedLoss: 99999,
    })
    expect(r.eligible).toBe(false)
    expect(r.reasons.length).toBeGreaterThanOrEqual(5)
  })

  it('rejects missing policies', () => {
    expect(evaluatePolicyEligibility(null, { customerId: 'u1' }).eligible).toBe(false)
  })
})

describe('field encryption', () => {
  const crypto = createFieldCrypto(Buffer.alloc(32, 7))
  it('encrypts with a random IV and decrypts back', () => {
    const a = crypto.encrypt('40221187')
    const b = crypto.encrypt('40221187')
    expect(a).toMatch(/^v1:/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('40221187')
    expect(crypto.decrypt(a)).toBe('40221187')
  })
  it('hashes deterministically for duplicate detection', () => {
    expect(crypto.hash('40221187')).toBe(crypto.hash('40221187'))
    expect(crypto.hash('40221187')).not.toBe(crypto.hash('40221188'))
  })
  it('reads values the migration left as plain text', () => {
    expect(crypto.decrypt('plain:12345678')).toBe('12345678')
  })
  it('rejects tampered ciphertext', () => {
    const value = crypto.encrypt('secret')
    const tampered = `${value.slice(0, -4)}AAAA`
    expect(() => crypto.decrypt(tampered)).toThrow()
  })
  it('is required for real data (outside demo and test databases)', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@h:5432/d', AUTH_TOKEN_SECRET: 's'.repeat(40), SEED_DEMO_DATA: 'false', FIELD_ENCRYPTION_KEY: '' })).toThrow(/FIELD_ENCRYPTION_KEY/)
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u:p@h:5432/d', AUTH_TOKEN_SECRET: 's'.repeat(40), SEED_DEMO_DATA: 'true', FIELD_ENCRYPTION_KEY: '' })).not.toThrow()
  })
})

describe('server configuration', () => {
  it('requires a PostgreSQL connection string and a session-signing secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: '', AUTH_TOKEN_SECRET: 's'.repeat(40) })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@h:5432/d', AUTH_TOKEN_SECRET: 'short' })).toThrow(/AUTH_TOKEN_SECRET/)
  })
  it('never seeds demo data in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h:5432/d', AUTH_TOKEN_SECRET: 's'.repeat(40), SEED_DEMO_DATA: 'true', FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })).toThrow(/SEED_DEMO_DATA/)
  })
})

describe('simulated payment adapter', () => {
  const adapter = createSimulatedPaymentAdapter()
  it('is clearly labelled as simulated', () => {
    expect(adapter.isSimulated).toBe(true)
    expect(adapter.name).toBe('SIMULATED')
  })
  it('returns SIM- references on success and is deterministic per key', async () => {
    const a = await adapter.initiateTransfer({ amount: 100, beneficiaryAccount: '12345678', idempotencyKey: 'k1-abcdef' })
    const b = await adapter.initiateTransfer({ amount: 100, beneficiaryAccount: '12345678', idempotencyKey: 'k1-abcdef' })
    expect(a.status).toBe('SUCCEEDED')
    expect(a.providerReference).toMatch(/^SIM-TXN-/)
    expect(a.providerReference).toBe(b.providerReference)
  })
  it('fails for closed accounts and limit breaches', async () => {
    expect((await adapter.initiateTransfer({ amount: 5, beneficiaryAccount: '77310000', idempotencyKey: 'k2-abcdef' })).failureCode).toBe('ACCOUNT_CLOSED')
    expect((await adapter.initiateTransfer({ amount: 2_000_000, beneficiaryAccount: '1234', idempotencyKey: 'k3-abcdef' })).failureCode).toBe('LIMIT_EXCEEDED')
  })
})

describe('query builder', () => {
  it('parameterises values and supports operators', () => {
    const params = []
    const sql = buildWhere({ status: { in: ['A', 'B'] }, x: null, $or: [{ a: 1 }, { b: { ilike: '%z%' } }] }, params)
    expect(sql).toBe('"status" = any($1) and "x" is null and (("a" = $2) or ("b"::text ilike $3))')
    expect(params).toEqual([['A', 'B'], 1, '%z%'])
  })
  it('rejects unsafe identifiers and sort directions', () => {
    expect(() => buildWhere({ 'status; drop table claims': 1 }, [])).toThrow()
    expect(() => buildOrderBy([['created_at', 'desc; drop']])).toThrow()
  })
  it('treats empty IN lists as false', () => {
    expect(buildWhere({ id: { in: [] } }, [])).toBe('false')
  })
})

describe('utilities', () => {
  it('maps database errors to API errors', () => {
    expect(fromDatabaseError({ code: '23505', constraint: 'x' }).status).toBe(409)
    const trig = fromDatabaseError({ code: 'P0001', message: 'COMPLIANCE_HOLD_ACTIVE: blocked' })
    expect(trig.code).toBe('COMPLIANCE_HOLD_ACTIVE')
  })
  it('masks accounts and sanitises filenames', () => {
    expect(maskAccount('12345678')).toBe('•••• 5678')
    expect(maskLast4('5678')).toBe('•••• 5678')
    expect(sanitizeFileName('../../etc/pass<wd>.pdf')).toBe('pass_wd_.pdf')
  })
})
