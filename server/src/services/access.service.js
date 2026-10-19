import {
  ROLES,
  DOCUMENT_STAGE_STATUSES,
  COMPLIANCE_STAGE_STATUSES,
  PAYMENT_STAGE_STATUSES,
  STAFF_ROLES,
} from '../../../shared/constants.js'
import { can, canSeeTab, hasAnyRole } from '../../../shared/permissions.js'
import { forbidden, notFound } from '../utils/errors.js'

const FULL_SCOPE_ROLES = [ROLES.CLAIMS_OPERATIONS, ROLES.CLAIMS_MANAGER, ROLES.AUDITOR]

async function distinctClaimIds(t, sql, params) {
  const rows = await t.query(sql, params)
  return rows.map((r) => r.claim_id)
}

/**
 * Returns a filter that restricts claims to the user's authorized scope, or
 * null when the user may not see any claims. Mirrored by the
 * public.can_access_claim() RLS helper in the database.
 */
export async function claimScope(t, user) {
  const roles = user.roles
  const branches = []
  if (roles.includes(ROLES.CUSTOMER)) branches.push({ customer_id: user.id })

  const staff = []
  if (hasAnyRole(roles, FULL_SCOPE_ROLES)) {
    staff.push({})
  } else {
    if (roles.includes(ROLES.DOCUMENT_REVIEWER)) {
      staff.push({ status: { in: DOCUMENT_STAGE_STATUSES } }, { assigned_reviewer_id: user.id })
    }
    if (roles.includes(ROLES.CLAIMS_ADJUSTER)) {
      const ids = await distinctClaimIds(
        t,
        `select distinct claim_id from public.claim_assignments where assignee_id = $1 and assignment_role = 'ADJUSTER'`,
        [user.id],
      )
      staff.push({ id: { in: ids } })
    }
    if (roles.includes(ROLES.COMPLIANCE_OFFICER)) {
      const ids = await distinctClaimIds(t, 'select distinct claim_id from public.compliance_reviews', [])
      staff.push({ status: { in: COMPLIANCE_STAGE_STATUSES } }, { id: { in: ids } })
    }
    if (roles.includes(ROLES.PAYMENT_OPERATIONS)) {
      const ids = await distinctClaimIds(t, 'select distinct claim_id from public.payments', [])
      staff.push({ status: { in: PAYMENT_STAGE_STATUSES } }, { id: { in: ids } })
    }
  }
  if (staff.length) {
    branches.push({ $and: [{ status: { ne: 'DRAFT' } }, { $or: staff }] })
    branches.push({ $and: [{ status: 'DRAFT' }, { created_by: user.id }] })
  }
  if (branches.length === 0) return null
  return { $or: branches }
}

/**
 * Loads a claim the user is authorized to see. Unauthorized and missing claims
 * both return 404 so claim existence is not disclosed.
 */
export async function loadAccessibleClaim(t, user, claimId, { forUpdate = false } = {}) {
  const scope = await claimScope(t, user)
  if (!scope) throw notFound('Claim not found')
  const claim = await t.findOne('claims', { $and: [{ id: claimId }, scope] }, { forUpdate })
  if (!claim) throw notFound('Claim not found')
  return claim
}

export function isStaff(user) {
  return hasAnyRole(user.roles, STAFF_ROLES)
}

/** True when the user is looking at their own claim as a policyholder. */
export function isCustomerView(user, claim) {
  return claim.customer_id === user.id
}

export function requireStaffView(user, claim) {
  if (isCustomerView(user, claim) || !isStaff(user)) {
    throw forbidden('This information is only available to authorized staff')
  }
}

export function requireTab(user, claim, tab) {
  requireStaffView(user, claim)
  if (!canSeeTab(user.roles, tab)) throw forbidden(`Your role cannot access the ${tab} section`)
}

export function requirePermission(user, permission) {
  if (!can(user.roles, permission)) throw forbidden(`Missing permission: ${permission}`)
}

/** Staff may not act on claims where they are the claimant (conflict of interest). */
export function requireNotOwnClaim(user, claim) {
  if (claim.customer_id === user.id) {
    throw forbidden('You cannot act as staff on your own claim', 'CONFLICT_OF_INTEREST')
  }
}
