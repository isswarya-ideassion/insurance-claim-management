import { CUSTOMER_STATUS_LABELS, STATUS_LABELS, STAGE_LABELS, ACTIVE_STATUSES, fraudBand } from '../../../shared/constants.js'
import { can } from '../../../shared/permissions.js'

/** Returns { [userId]: { id, full_name, email } } for the given ids. */
export async function profileMap(t, ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return {}
  const rows = await t.findMany('users', { where: { id: { in: unique } }, columns: ['id', 'full_name', 'email'] })
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

export const nameOf = (map, id) => (id && map[id] ? map[id].full_name || map[id].email : null)

/**
 * Decrypted claimant contact details by claim id: { contact_name, contact_phone, contact_email }.
 * Contact data is encrypted at rest (claim_parties.contact_encrypted).
 */
export async function claimantContacts(t, crypto, claimIds) {
  const ids = [...new Set(claimIds.filter(Boolean))]
  if (ids.length === 0) return {}
  const rows = await t.findMany('claim_parties', { where: { claim_id: { in: ids }, party_type: 'CLAIMANT' } })
  return Object.fromEntries(
    rows.map((p) => {
      const contact = p.contact_encrypted ? crypto.decryptJson(p.contact_encrypted) : null
      return [p.claim_id, { contact_name: p.name, contact_phone: contact?.phone ?? null, contact_email: contact?.email ?? null }]
    }),
  )
}

const CUSTOMER_FIELDS = [
  'id',
  'claim_number',
  'claim_type',
  'policy_id',
  'insured_name',
  'loss_date',
  'loss_location',
  'loss_city',
  'loss_country',
  'loss_type',
  'loss_description',
  'estimated_loss',
  'affected_asset',
  'declaration_accepted',
  'draft_step',
  'opened_at',
  'closed_at',
  'rejection_reason',
  'created_at',
  'updated_at',
  'version',
]

const EMPTY_CONTACT = { contact_name: null, contact_phone: null, contact_email: null }

/** Customer-safe projection: internal fields, holds, scores and staff assignments are removed. */
export function presentClaimForCustomer(claim, contact = null) {
  const out = {}
  for (const key of CUSTOMER_FIELDS) out[key] = claim[key] ?? null
  Object.assign(out, contact || EMPTY_CONTACT)
  const visibleStatus = claim.status === 'ON_HOLD' ? claim.hold_from_status : claim.status
  out.status = visibleStatus
  out.status_label = CUSTOMER_STATUS_LABELS[visibleStatus]
  out.view = 'customer'
  return out
}

/** Fraud governance: the numeric score for managers and compliance, the risk band for adjusters, nothing for others. */
export function maskFraud(claim, roles) {
  const { fraud_score: score, ...rest } = claim
  if (can(roles, 'fraud.viewScore')) return { ...rest, fraud_score: score ?? null, fraud_band: fraudBand(score) }
  if (can(roles, 'fraud.viewBand')) return { ...rest, fraud_band: fraudBand(score) }
  return rest
}

export function presentClaimForStaff(claim, names = {}, roles = [], contact = null) {
  const now = Date.now()
  return {
    ...maskFraud(claim, roles),
    ...(contact || {}),
    status_label: STATUS_LABELS[claim.status],
    stage_label: STAGE_LABELS[claim.stage] || null,
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
  return claims.map((c) => (c.customer_id === user.id ? presentClaimForCustomer(c) : presentClaimForStaff(c, names, user.roles)))
}
