import { describe, expect, it } from 'vitest'
import { ALL_ROLES } from '@shared/constants.js'
import { NAVIGATION, ROLE_HOME, ROUTE_ROLES } from '@/constants/navigation.js'

// Maps each navigable path to the ROUTE_ROLES entry guarding it in AppRoutes.
const PATH_GUARD = [
  [/^\/customer(\/|$)/, 'customer'],
  [/^\/operations$/, 'operations'],
  [/^\/policy-renewals$/, 'renewals'],
  [/^\/claims/, 'claims'],
  [/^\/tasks$/, 'tasks'],
  [/^\/document-review$/, 'documentReview'],
  [/^\/adjuster$/, 'adjuster'],
  [/^\/manager\/decisions$/, 'decisions'],
  [/^\/manager\/reserves$/, 'reserves'],
  [/^\/manager\/unassigned$/, 'unassigned'],
  [/^\/manager/, 'manager'],
  [/^\/settlements$/, 'settlements'],
  [/^\/config$/, 'config'],
  [/^\/integrations$/, 'integrations'],
  [/^\/compliance$/, 'compliance'],
  [/^\/payments/, 'payments'],
  [/^\/reports$/, 'reports'],
  [/^\/audit$/, 'audit'],
  [/^\/admin/, 'admin'],
  [/^\/customer-records/, 'customerRecords'],
  [/^\/automation/, 'automation'],
  [/^\/notifications$/, null],
]

const guardFor = (path) => PATH_GUARD.find(([re]) => re.test(path))

describe('role-based navigation', () => {
  it('defines a home and navigation for every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_HOME[role], role).toBeTruthy()
      expect(NAVIGATION[role]?.length, role).toBeGreaterThan(0)
    }
  })

  it('only links each role to routes that role may open', () => {
    for (const role of ALL_ROLES) {
      for (const item of NAVIGATION[role]) {
        const match = guardFor(item.to)
        expect(match, `${role} → ${item.to} has no guard mapping`).toBeTruthy()
        const [, key] = match
        if (key) expect(ROUTE_ROLES[key], `${role} cannot open ${item.to}`).toContain(role)
      }
    }
  })

  it('keeps notifications out of the sidebar (the header bell is the only entry point)', () => {
    for (const role of ALL_ROLES) {
      expect(NAVIGATION[role].some((i) => i.to === '/notifications'), role).toBe(false)
    }
  })

  it('sends each role home to a route it may open', () => {
    for (const role of ALL_ROLES) {
      const [, key] = guardFor(ROLE_HOME[role])
      expect(ROUTE_ROLES[key]).toContain(role)
    }
  })

  it('uses the seven PRD roles plus the Claims Operations Manager', () => {
    expect(ALL_ROLES).toEqual(['CLIENT', 'CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'ADJUSTER', 'DOCUMENT_REVIEWER', 'PAYMENT_OPERATOR', 'DATA_ENGINEER', 'COMPLIANCE_SECURITY'])
  })

  it('sends the Claims Operations Manager to intake work and keeps approval screens with the Claims Manager', () => {
    expect(ROLE_HOME.CLAIMS_OPS_MANAGER).toBe('/operations')
    expect(ROLE_HOME.OPS_MANAGER).toBe('/manager')
    for (const key of ['reserves', 'settlements', 'decisions', 'manager', 'compliance', 'payments']) {
      expect(ROUTE_ROLES[key], key).not.toContain('CLAIMS_OPS_MANAGER')
    }
    expect(ROUTE_ROLES.unassigned).toEqual(expect.arrayContaining(['CLAIMS_OPS_MANAGER', 'OPS_MANAGER']))
  })

  it('limits customer records and user administration to Compliance & Security', () => {
    expect(ROUTE_ROLES.customerRecords).toEqual(['COMPLIANCE_SECURITY'])
    expect(ROUTE_ROLES.admin).toEqual(['COMPLIANCE_SECURITY'])
  })

  it('keeps clients out of staff areas and staff out of the client portal', () => {
    for (const key of Object.keys(ROUTE_ROLES).filter((k) => k !== 'customer')) {
      expect(ROUTE_ROLES[key], key).not.toContain('CLIENT')
    }
    expect(ROUTE_ROLES.customer).toEqual(['CLIENT'])
    expect(NAVIGATION.CLIENT.every((i) => i.to.startsWith('/customer'))).toBe(true)
  })

  it('routes settlement approvals to Adjusters and Claims Managers, reserve reviews to Claims Managers', () => {
    expect(ROUTE_ROLES.settlements).toEqual(expect.arrayContaining(['ADJUSTER', 'OPS_MANAGER']))
    expect(ROUTE_ROLES.settlements).not.toContain('PAYMENT_OPERATOR')
    expect(ROUTE_ROLES.reserves).not.toContain('PAYMENT_OPERATOR')
    expect(ROUTE_ROLES.reserves).not.toContain('ADJUSTER')
  })
})
