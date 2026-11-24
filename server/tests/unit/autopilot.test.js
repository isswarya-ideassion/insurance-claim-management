import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AUTO_REJECT_REASON,
  autopilotActor,
  autopilotProviderReady,
  decideDocument,
  decideIntake,
  decideRouting,
  payeeRisk,
  stpBlockers,
} from '../../src/modules/automation/autopilot.service.js'
import { AUTOPILOT_ACTIONS, AUTOPILOT_STAGES, BEACON_AUTOPILOT_USER_ID, ROLES } from '../../../shared/constants.js'
import { PERMISSIONS, can } from '../../../shared/permissions.js'

const MAX = 25_000
const cleanClaim = { id: 'c1', estimated_loss: 18_000, possible_duplicate_of: null, coverage_result: null }
const cleanTriage = { fraudScore: 8, fraudBand: 'LOW', fraudReasons: [], aboveReviewThreshold: false, imageFraudAlerts: [] }
// Beacon's checker always sets needsHuman (confidence is capped at 0.6); the auto-pilot judges the facts instead.
const covered = { result: 'COVERED', needsHuman: true, confidence: 0.6, hardChecks: { passed: true, reasons: [] }, coveringClauses: [{ id: 'COV-1' }], exclusionClauses: [] }
const noRisk = { openFraudFlags: 0, ring: null, anomalyBand: 'TYPICAL', complianceHold: false }
const codes = (blockers) => blockers.map((b) => b.code)

const imageAlert = (overrides = {}) => ({
  documentId: 'd1',
  riskLevel: 'HIGH',
  relevance: 'RELEVANT',
  checks: [{ check: 'DUPLICATE_IMAGE', code: 'DUPLICATE_DOCUMENT_IMAGE', severity: 'HIGH', evidence: 'Same file on another claim' }],
  ...overrides,
})

describe('Beacon Auto-Pilot: intake (straight-through processing)', () => {
  it('goes straight through only when covered, under the limit and free of risk signals', () => {
    expect(decideIntake({ claim: cleanClaim, coverage: covered, triage: cleanTriage, risk: noRisk, maxLoss: MAX })).toEqual({ automate: true, blockers: [] })
  })

  it('leaves unclear coverage for the Claims Ops Manager', () => {
    for (const coverage of [{ ...covered, result: 'NEEDS_REVIEW' }, { ...covered, result: 'NOT_COVERED' }, { ...covered, coveringClauses: [] }, { ...covered, exclusionClauses: [{ id: 'EXC-1' }] }, { ...covered, hardChecks: { passed: false } }, { ...covered, hardChecks: undefined }, null]) {
      const d = decideIntake({ claim: cleanClaim, coverage, triage: cleanTriage, risk: noRisk, maxLoss: MAX })
      expect(d.automate).toBe(false)
      expect(codes(d.blockers)).toContain('COVERAGE_UNCLEAR')
    }
  })

  it('applies the STP loss threshold inclusively and refuses a claim with no estimate', () => {
    expect(decideIntake({ claim: { ...cleanClaim, estimated_loss: 25_000 }, coverage: covered, triage: cleanTriage, risk: noRisk, maxLoss: MAX }).automate).toBe(true)
    expect(codes(decideIntake({ claim: { ...cleanClaim, estimated_loss: 25_000.01 }, coverage: covered, triage: cleanTriage, risk: noRisk, maxLoss: MAX }).blockers)).toEqual(['ABOVE_STP_THRESHOLD'])
    expect(codes(decideIntake({ claim: { ...cleanClaim, estimated_loss: null }, coverage: covered, triage: cleanTriage, risk: noRisk, maxLoss: MAX }).blockers)).toEqual(['NO_ESTIMATE'])
  })

  it('keeps every fraud or anomaly signal away from automation', () => {
    const cases = [
      [{ triage: { ...cleanTriage, fraudReasons: [{ code: 'LATE_REPORTING' }] } }, 'FRAUD_SIGNALS'],
      [{ triage: { ...cleanTriage, aboveReviewThreshold: true } }, 'FRAUD_SIGNALS'],
      [{ triage: { ...cleanTriage, fraudBand: 'MEDIUM' } }, 'FRAUD_SIGNALS'],
      [{ triage: { ...cleanTriage, imageFraudAlerts: [imageAlert()] } }, 'IMAGE_FRAUD_ALERT'],
      [{ triage: null }, 'NO_TRIAGE'],
      [{ risk: { ...noRisk, openFraudFlags: 1 } }, 'FRAUD_SIGNALS'],
      [{ risk: { ...noRisk, ring: { band: 'HIGH' } } }, 'FRAUD_RING'],
      [{ risk: { ...noRisk, anomalyBand: 'EXTREME' } }, 'ANOMALY'],
      [{ risk: { ...noRisk, complianceHold: true } }, 'COMPLIANCE_HOLD'],
      [{ claim: { ...cleanClaim, possible_duplicate_of: 'c0' } }, 'POSSIBLE_DUPLICATE'],
    ]
    for (const [override, code] of cases) {
      const d = decideIntake({ claim: cleanClaim, coverage: covered, triage: cleanTriage, risk: noRisk, maxLoss: MAX, ...override })
      expect(d.automate, code).toBe(false)
      expect(codes(d.blockers)).toContain(code)
    }
  })

  it('does not count an unrelated-document notice as a fraud alert', () => {
    const notice = imageAlert({ relevance: 'IRRELEVANT', checks: [{ check: 'IRRELEVANT_DOCUMENT', code: 'X', severity: 'MEDIUM', evidence: 'n/a' }] })
    expect(stpBlockers({ claim: cleanClaim, maxLoss: MAX, triage: { ...cleanTriage, imageFraudAlerts: [notice] }, risk: noRisk })).toEqual([])
  })
})

describe('Beacon Auto-Pilot: adjuster routing', () => {
  it('routes only claims whose coverage is recorded as covered', () => {
    expect(decideRouting({ claim: { ...cleanClaim, coverage_result: 'COVERED' }, triage: cleanTriage, risk: noRisk, maxLoss: MAX }).automate).toBe(true)
    expect(codes(decideRouting({ claim: { ...cleanClaim, coverage_result: 'NEEDS_REVIEW' }, triage: cleanTriage, risk: noRisk, maxLoss: MAX }).blockers)).toEqual(['COVERAGE_UNCLEAR'])
  })
})

describe('Beacon Auto-Pilot: document review', () => {
  it('accepts a clean, relevant document', () => {
    expect(decideDocument({ fraudAlerts: [], relevance: 'RELEVANT' })).toMatchObject({ decision: 'ACCEPT', reasonCode: 'CLEAN_RELEVANT' })
  })

  it('rejects an unnecessary document with the fixed reason', () => {
    expect(decideDocument({ fraudAlerts: [], relevance: 'IRRELEVANT' })).toMatchObject({ decision: 'REJECT', reasonCode: 'IRRELEVANT' })
    expect(AUTO_REJECT_REASON).toBe('Auto-rejected by Beacon AI: unnecessary or non-claim document')
  })

  it('escalates a fraud indicator even when the file is otherwise relevant, flagging high risk', () => {
    expect(decideDocument({ fraudAlerts: [imageAlert()], relevance: 'RELEVANT' })).toMatchObject({ decision: 'ESCALATE', reasonCode: 'IMAGE_FRAUD_ALERT', highRisk: true })
    expect(decideDocument({ fraudAlerts: [imageAlert({ riskLevel: 'MEDIUM' })], relevance: 'IRRELEVANT' })).toMatchObject({ decision: 'ESCALATE', highRisk: false })
  })

  it('escalates what Beacon could not read or judge', () => {
    expect(decideDocument({ fraudAlerts: [], relevance: 'UNKNOWN', detail: 'No legible text' })).toMatchObject({ decision: 'ESCALATE', reasonCode: 'UNREADABLE', message: 'No legible text' })
    expect(decideDocument({ fraudAlerts: [], relevance: undefined }).decision).toBe('ESCALATE')
  })
})

describe('Beacon Auto-Pilot: payee shield', () => {
  it('rates a shared bank account, or new details with a mismatch, as high risk', () => {
    expect(payeeRisk({ signals: ['DUPLICATE_PAYEE'], anomalies: [] }).level).toBe('HIGH')
    expect(payeeRisk({ signals: ['NEW_BANK_DETAILS'], anomalies: [{ code: 'NAME_MISMATCH' }] }).level).toBe('HIGH')
    expect(payeeRisk({ signals: ['NEW_BANK_DETAILS', 'THIRD_PARTY_PAYEE'], anomalies: [] }).level).toBe('HIGH')
  })

  it('does not flag a first payment on its own', () => {
    expect(payeeRisk({ signals: ['NEW_BANK_DETAILS'], anomalies: [] }).level).toBe('LOW')
    expect(payeeRisk({ signals: [], anomalies: [] }).level).toBe('NONE')
  })
})

describe('Beacon Auto-Pilot: guardrails', () => {
  it('runs unattended only on the local Beacon provider', () => {
    expect(autopilotProviderReady({ name: 'beacon', configured: true })).toBe(true)
    expect(autopilotProviderReady({ name: 'anthropic', configured: true })).toBe(false)
    expect(autopilotProviderReady({ name: 'beacon', configured: false })).toBe(false)
  })

  it('acts as an AGENT service identity holding exactly one role per step', () => {
    const actor = autopilotActor(ROLES.DOCUMENT_REVIEWER, 'req-1')
    expect(actor).toMatchObject({ id: BEACON_AUTOPILOT_USER_ID, type: 'AGENT', roles: [ROLES.DOCUMENT_REVIEWER], autopilot: true })
  })

  it('cannot reach any approval, payment, denial, hold or fraud-flag code path', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/modules/automation/autopilot.service.js', import.meta.url)), 'utf8')
    // No settlement, payment, reserve-review, compliance-decision or closure module is imported.
    for (const mod of ['settlements', 'payments', 'reserves', 'compliance', 'closure', 'evaluations']) {
      expect(source, mod).not.toMatch(new RegExp(`from '\\.\\./${mod}/`))
    }
    // The only status change it makes directly is "documents complete"; others go through assignClaim / reviewDocument.
    expect([...source.matchAll(/transitionClaim\(ctx, t, \w+, '([A-Z_]+)'/g)].map((m) => m[1])).toEqual(['ADJUSTER_ASSIGNMENT'])
    // It reads fraud flags (to keep flagged claims away from automation) but never writes one.
    for (const forbidden of ["insert('claim_fraud_flags'", 'into public.claim_fraud_flags', 'hold_active: true', "'REJECTED'", 'payment_blocks', "verification_status: 'VERIFIED'", 'applyAgentRun']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })

  it('gives operations leads the sweep and managers the switch', () => {
    expect(can([ROLES.DOCUMENT_REVIEWER], 'autopilot.run')).toBe(true)
    expect(can([ROLES.DOCUMENT_REVIEWER], 'autopilot.manage')).toBe(false)
    expect(can([ROLES.OPS_MANAGER], 'autopilot.manage')).toBe(true)
    expect(can([ROLES.ADJUSTER], 'autopilot.run')).toBe(false)
    expect(can([ROLES.CLIENT], 'autopilot.view')).toBe(false)
    expect(Object.keys(PERMISSIONS)).toEqual(expect.arrayContaining(['autopilot.view', 'autopilot.run', 'autopilot.manage']))
  })

  it('credits time saved only for automated actions', () => {
    for (const [action, def] of Object.entries(AUTOPILOT_ACTIONS)) {
      expect(AUTOPILOT_STAGES[def.stage], action).toBeTruthy()
      if (def.outcome === 'ESCALATED') expect(def.minutes, action).toBe(0)
      else expect(def.minutes, action).toBeGreaterThan(0)
    }
  })
})
