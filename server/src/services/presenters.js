import { CUSTOMER_STATUS_LABELS, STATUS_LABELS, ACTIVE_STATUSES } from '../../../shared/constants.js'

/** Returns { [profileId]: { id, full_name, email } } for the given ids. */
export async function profileMap(t, ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return {}
  const rows = await t.findMany('profiles', { where: { id: { in: unique } }, columns: ['id', 'full_name', 'email'] })
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

export const nameOf = (map, id) => (id && map[id] ? map[id].full_name || map[id].email : null)

const CUSTOMER_FIELDS = [
  'id',
  'claim_number',
  'claim_type',
  'policy_id',
  'insured_name',
  'incident_at',
  'incident_location',
  'incident_category',
  'incident_description',
  'estimated_loss',
  'affected_asset',
  'contact_name',
  'contact_phone',
  'contact_email',
  'declaration_accepted',
  'draft_step',
  'submitted_at',
  'closed_at',
  'rejection_reason',
  'created_at',
  'updated_at',
]

/** Customer-safe projection: internal fields, holds and staff assignments are removed. */
export function presentClaimForCustomer(claim) {
  const out = {}
  for (const key of CUSTOMER_FIELDS) out[key] = claim[key] ?? null
  const visibleStatus = claim.status === 'ON_HOLD' ? claim.hold_from_status : claim.status
  out.status = visibleStatus
  out.status_label = CUSTOMER_STATUS_LABELS[visibleStatus]
  out.view = 'customer'
  return out
}

export function presentClaimForStaff(claim, names = {}) {
  const now = Date.now()
  return {
    ...claim,
    status_label: STATUS_LABELS[claim.status],
    customer_name: nameOf(names, claim.customer_id),
    assigned_owner_name: nameOf(names, claim.assigned_owner_id),
    assigned_adjuster_name: nameOf(names, claim.assigned_adjuster_id),
    assigned_reviewer_name: nameOf(names, claim.assigned_reviewer_id),
    is_overdue: Boolean(claim.due_date && new Date(claim.due_date).getTime() < now && ACTIVE_STATUSES.includes(claim.status)),
    view: 'staff',
  }
}

export async function presentClaims(t, claims, user) {
  const names = await profileMap(
    t,
    claims.flatMap((c) => [c.customer_id, c.assigned_owner_id, c.assigned_adjuster_id, c.assigned_reviewer_id]),
  )
  return claims.map((c) => (c.customer_id === user.id ? presentClaimForCustomer(c) : presentClaimForStaff(c, names)))
}
