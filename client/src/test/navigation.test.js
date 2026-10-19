import { describe, expect, it } from 'vitest'
import { ALL_ROLES } from '@shared/constants.js'
import { NAVIGATION, ROLE_HOME, ROUTE_ROLES } from '@/constants/navigation.js'

// Maps each navigable path to the ROUTE_ROLES entry guarding it in AppRoutes.
const PATH_GUARD = [
  [/^\/customer/, 'customer'],
  [/^\/operations$/, 'operations'],
  [/^\/claims/, 'claims'],
  [/^\/tasks$/, 'tasks'],
  [/^\/document-review$/, 'documentReview'],
  [/^\/adjuster$/, 'adjuster'],
  [/^\/manager\/decisions$/, 'decisions'],
  [/^\/manager/, 'manager'],
  [/^\/compliance$/, 'compliance'],
  [/^\/payments/, 'payments'],
  [/^\/reports$/, 'reports'],
  [/^\/audit$/, 'audit'],
  [/^\/admin/, 'admin'],
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

  it('sends each role home to a route it may open', () => {
    for (const role of ALL_ROLES) {
      const [, key] = guardFor(ROLE_HOME[role])
      expect(ROUTE_ROLES[key]).toContain(role)
    }
  })

  it('keeps customers out of staff areas and staff out of the customer portal', () => {
    expect(ROUTE_ROLES.claims).not.toContain('CUSTOMER')
    expect(ROUTE_ROLES.admin).toEqual(['DATA_ADMIN'])
    expect(ROUTE_ROLES.customer).toEqual(['CUSTOMER'])
    expect(NAVIGATION.CUSTOMER.every((i) => i.to.startsWith('/customer') || i.to === '/notifications')).toBe(true)
  })
})
