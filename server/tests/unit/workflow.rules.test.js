import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_STATUSES, ROLES, STATUS_STAGE, LIFECYCLE_STAGES } from '../../../shared/constants.js'
import { TRANSITIONS, findTransition, transitionsFrom, rolesCanExecute, GUARD_DESCRIPTIONS, HOLDABLE_STATUSES } from '../../../shared/workflow.js'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('claim workflow rules', () => {
  it('has no duplicate transitions', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only references known statuses, the eight roles and known guards', () => {
    for (const t of TRANSITIONS) {
      expect(ALL_STATUSES).toContain(t.from)
      expect(ALL_STATUSES).toContain(t.to)
      for (const r of t.roles) expect(Object.values(ROLES)).toContain(r)
      for (const g of t.guards || []) expect(GUARD_DESCRIPTIONS).toHaveProperty(g)
    }
    expect(Object.values(ROLES)).toHaveLength(8)
  })

  it('maps every status except ON_HOLD to one of the nine lifecycle stages', () => {
    expect(LIFECYCLE_STAGES).toHaveLength(9)
    for (const status of ALL_STATUSES.filter((s) => s !== 'ON_HOLD')) expect(LIFECYCLE_STAGES).toContain(STATUS_STAGE[status])
  })

  it('gives every status except CLOSED at least one way forward, and CLOSED only reopens', () => {
    for (const status of ALL_STATUSES) {
      expect(transitionsFrom(status).length, status).toBeGreaterThan(0)
    }
    expect(transitionsFrom('CLOSED').map((t) => t.to)).toEqual(['REOPENED'])
  })

  it('makes every status reachable from DRAFT', () => {
    const seen = new Set(['DRAFT'])
    const queue = ['DRAFT']
    while (queue.length) {
      const s = queue.shift()
      for (const t of transitionsFrom(s)) if (!seen.has(t.to)) { seen.add(t.to); queue.push(t.to) }
    }
    expect([...seen].sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('rejects arbitrary jumps such as SUBMITTED -> PAID', () => {
    expect(findTransition('SUBMITTED', 'PAID')).toBeNull()
    expect(findTransition('DRAFT', 'CLOSED')).toBeNull()
    expect(findTransition('INVESTIGATION', 'PAYMENT_PENDING')).toBeNull()
  })

  it('implements the reserve decision node: within authority posts, above authority goes to manager review', () => {
    expect(findTransition('INVESTIGATION', 'COMPLIANCE_REVIEW').guards).toEqual(['evaluationSubmitted', 'reservePosted'])
    expect(findTransition('INVESTIGATION', 'RESERVE_APPROVAL').guards).toEqual(['evaluationSubmitted', 'reservePendingReview'])
    expect(findTransition('RESERVE_APPROVAL', 'COMPLIANCE_REVIEW').roles).toEqual([ROLES.OPS_MANAGER])
  })

  it('reserves payment outcomes for the payment service', () => {
    expect(findTransition('PAYMENT_PENDING', 'PAID').systemOnly).toBe(true)
    expect(findTransition('PAYMENT_PENDING', 'PAYMENT_FAILED').systemOnly).toBe(true)
  })

  it('lets only the Claims Manager close and reopen claims', () => {
    // Resuming a held claim to REOPENED is a hold release, not a reopening decision.
    for (const t of TRANSITIONS.filter((x) => ['CLOSED', 'REOPENED'].includes(x.to) && x.from !== 'ON_HOLD')) {
      expect(t.roles).toEqual([ROLES.OPS_MANAGER])
    }
  })

  it('requires every completion obligation before a paid claim closes', () => {
    const close = findTransition('PAID', 'CLOSED')
    expect(close.guards).toEqual(expect.arrayContaining(['paymentCompleted', 'noOpenMandatoryTasks', 'noPendingApprovals', 'noActiveComplianceHold']))
    expect(findTransition('REJECTED', 'CLOSED').closure).toBe('PERMITTED_OUTCOME')
    expect(findTransition('WITHDRAWN', 'CLOSED').closure).toBe('PERMITTED_OUTCOME')
  })

  it('blocks settlement and payment progress while a compliance hold is active', () => {
    expect(findTransition('COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL').guards).toContain('noActiveComplianceHold')
    expect(findTransition('SETTLEMENT_APPROVAL', 'PAYMENT_PENDING').guards).toContain('noActiveComplianceHold')
    expect(findTransition('PAYMENT_FAILED', 'PAYMENT_PENDING').guards).toContain('noActiveComplianceHold')
  })

  it('never lets clients make staff decisions or data engineers change claim status', () => {
    for (const t of TRANSITIONS) {
      expect(t.roles).not.toContain(ROLES.DATA_ENGINEER)
      if (t.roles.includes(ROLES.CLIENT)) {
        expect(['SUBMITTED', 'WITHDRAWN', 'DOCUMENT_REVIEW']).toContain(t.to)
      }
    }
    expect(rolesCanExecute(findTransition('RESERVE_APPROVAL', 'COMPLIANCE_REVIEW'), [ROLES.CLIENT])).toEqual([])
  })

  it('keeps denials with the Claims Manager', () => {
    for (const t of TRANSITIONS.filter((x) => x.to === 'REJECTED')) expect(t.roles).toEqual([ROLES.OPS_MANAGER])
  })

  it('only resumes held claims through guarded transitions', () => {
    for (const s of HOLDABLE_STATUSES) {
      const resume = findTransition('ON_HOLD', s)
      expect(resume.guards).toContain('resumesToHeldStatus')
    }
  })

  it('keeps the database transition table in sync with shared/workflow.js', () => {
    const sql = readFileSync(path.resolve(here, '../../../database/migrations/20261027000013_workflow_transitions.sql'), 'utf8')
    for (const t of TRANSITIONS) {
      expect(sql).toContain(`('${t.from}', '${t.to}', array[${t.roles.map((r) => `'${r}'`).join(', ')}]::text[]`)
    }
    expect((sql.match(/^\s+\('/gm) || []).length).toBe(TRANSITIONS.length)
  })
})
