import { describe, expect, it } from 'vitest'
import { PERMISSIONS, can, visibleTabs, canSeeTab } from '../../../shared/permissions.js'
import { ROLES } from '../../../shared/constants.js'
import { evaluatePolicyEligibility } from '../../src/services/eligibility.service.js'
import { createSimulatedPaymentAdapter } from '../../src/services/paymentAdapter.js'
import { assertApprovalAuthority, approvalCapability } from '../../src/services/approvalAuthority.js'
import { buildWhere, buildOrderBy } from '../../src/db/queryBuilder.js'
import { fromDatabaseError } from '../../src/utils/errors.js'
import { maskAccount, sanitizeFileName } from '../../src/utils/format.js'

describe('permissions', () => {
  it('keeps the auditor read-only', () => {
    const readOnly = ['claims.viewQueue', 'compliance.view', 'payments.view', 'reports.view', 'reports.teamMetrics', 'audit.view']
    for (const [perm, roles] of Object.entries(PERMISSIONS)) {
      if (!readOnly.includes(perm)) expect(roles, perm).not.toContain(ROLES.AUDITOR)
    }
  })

  it('restricts financial decisions to claims managers', () => {
    expect(PERMISSIONS['reserves.decide']).toEqual([ROLES.CLAIMS_MANAGER])
    expect(PERMISSIONS['settlements.decide']).toEqual([ROLES.CLAIMS_MANAGER])
    expect(can([ROLES.CLAIMS_ADJUSTER], 'reserves.decide')).toBe(false)
  })

  it('combines permissions for users with multiple roles', () => {
    const roles = [ROLES.CLAIMS_OPERATIONS, ROLES.CLAIMS_MANAGER]
    expect(can(roles, 'claims.verifyPolicy')).toBe(true)
    expect(can(roles, 'settlements.decide')).toBe(true)
    expect(can(roles, 'payments.process')).toBe(false)
  })

  it('hides claim tabs by role', () => {
    expect(visibleTabs([ROLES.PAYMENT_OPERATIONS])).not.toContain('documents')
    expect(canSeeTab([ROLES.COMPLIANCE_OFFICER], 'compliance')).toBe(true)
    expect(canSeeTab([ROLES.CLAIMS_ADJUSTER], 'compliance')).toBe(false)
    expect(visibleTabs([ROLES.CUSTOMER])).toEqual([])
  })

  it('throws on unknown permissions', () => {
    expect(() => can([ROLES.CLAIMS_MANAGER], 'does.not.exist')).toThrow()
  })
})

describe('policy eligibility', () => {
  const policy = {
    holder_id: 'u1',
    status: 'ACTIVE',
    policy_type: 'MOTOR',
    effective_from: '2026-01-01',
    effective_to: '2026-12-31',
    sum_insured: 40000,
  }

  it('accepts a matching active policy', () => {
    const r = evaluatePolicyEligibility(policy, { customerId: 'u1', incidentAt: '2026-06-01T10:00:00Z', claimType: 'MOTOR', incidentCategory: 'COLLISION', estimatedLoss: 1000 })
    expect(r.eligible).toBe(true)
  })

  it('rejects another customer’s policy', () => {
    expect(evaluatePolicyEligibility(policy, { customerId: 'u2' }).reasons).toContain('Policy does not belong to the claimant')
  })

  it('rejects lapsed policies, out-of-period incidents, wrong types and excessive losses', () => {
    const r = evaluatePolicyEligibility({ ...policy, status: 'LAPSED' }, {
      customerId: 'u1',
      incidentAt: '2025-12-30T10:00:00Z',
      claimType: 'HEALTH',
      incidentCategory: 'STORM',
      estimatedLoss: 99999,
    })
    expect(r.eligible).toBe(false)
    expect(r.reasons.length).toBeGreaterThanOrEqual(5)
  })

  it('rejects missing policies', () => {
    expect(evaluatePolicyEligibility(null, { customerId: 'u1' }).eligible).toBe(false)
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

describe('approval authority', () => {
  const manager = { id: 'm1', roles: [ROLES.CLAIMS_MANAGER], approvalLimit: 50000 }
  it('blocks self-approval', () => {
    expect(() => assertApprovalAuthority(manager, { amount: 10, requestedBy: 'm1', decision: 'APPROVED' })).toThrow(/submitted/)
  })
  it('blocks approvals above the limit but allows returns', () => {
    expect(() => assertApprovalAuthority(manager, { amount: 60000, requestedBy: 'a1', decision: 'APPROVED' })).toThrow(/exceeds your approval limit/)
    expect(() => assertApprovalAuthority(manager, { amount: 60000, requestedBy: 'a1', decision: 'RETURNED' })).not.toThrow()
  })
  it('blocks non-managers', () => {
    expect(() => assertApprovalAuthority({ id: 'x', roles: [ROLES.CLAIMS_ADJUSTER] }, { amount: 1, requestedBy: 'a', decision: 'APPROVED' })).toThrow()
  })
  it('reports capability for the UI', () => {
    expect(approvalCapability(manager, { amount: 70000, requestedBy: 'a1' })).toMatchObject({ canDecide: true, canApprove: false })
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
    expect(sanitizeFileName('../../etc/pass<wd>.pdf')).toBe('pass_wd_.pdf')
  })
})
