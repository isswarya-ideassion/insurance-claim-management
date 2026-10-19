import { ROLES } from '../../../shared/constants.js'
import { forbidden } from '../utils/errors.js'

const money = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/**
 * Financial approval checks shared by reserve and settlement decisions.
 * The database enforces the same rules (approvals CHECK constraints and the
 * approvals_enforce_authority trigger).
 */
export function assertApprovalAuthority(actor, { amount, requestedBy, decision }) {
  if (!actor.roles.includes(ROLES.CLAIMS_MANAGER)) {
    throw forbidden('Only claims managers can decide financial approvals', 'APPROVAL_NOT_AUTHORISED')
  }
  if (requestedBy === actor.id) {
    throw forbidden('You cannot decide a request you submitted', 'SELF_APPROVAL_FORBIDDEN')
  }
  if (decision === 'APPROVED') {
    const limit = actor.approvalLimit == null ? null : Number(actor.approvalLimit)
    if (limit == null || Number(amount) > limit) {
      throw forbidden(
        `${money(amount)} exceeds your approval limit of ${money(limit || 0)}. Refer this request to a manager with higher authority.`,
        'APPROVAL_LIMIT_EXCEEDED',
      )
    }
  }
}

export function approvalCapability(actor, { amount, requestedBy }) {
  if (!actor.roles.includes(ROLES.CLAIMS_MANAGER)) return { canDecide: false, reason: 'Not a claims manager' }
  if (requestedBy === actor.id) return { canDecide: false, reason: 'You submitted this request' }
  const limit = actor.approvalLimit == null ? null : Number(actor.approvalLimit)
  if (limit == null || Number(amount) > limit) {
    return { canDecide: true, canApprove: false, reason: `Exceeds your approval limit of ${money(limit || 0)}` }
  }
  return { canDecide: true, canApprove: true, reason: null }
}
