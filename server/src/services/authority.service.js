import { ROLES } from '../../../shared/constants.js'
import { forbidden } from '../utils/errors.js'
import { effectiveLimit } from './config.service.js'
import { formatInr } from '../utils/format.js'

const money = (n) => formatInr(n)

/**
 * Monetary authority (PRD section 2.3). Every check here is repeated by the
 * database: reviews_enforce (reserve reviews) and settlement_steps_enforce
 * (settlement approvals) use public.effective_limit() as well.
 */

/** What the actor may do with a reserve awaiting manager review. */
export async function reserveReviewCapability(t, actor, reserve, claim) {
  if (!actor.roles.includes(ROLES.OPS_MANAGER)) return { canDecide: false, canApprove: false, reason: 'Only a Claims Manager reviews reserves' }
  if (reserve.set_by === actor.id) return { canDecide: false, canApprove: false, reason: 'You set this reserve' }
  const limit = await effectiveLimit(t, actor.id, 'RESERVE', claim.segment, reserve.coverage_line)
  if (limit == null || Number(reserve.amount) > limit) {
    return { canDecide: true, canApprove: false, limit, reason: `Exceeds your reserve authority of ${money(limit)}` }
  }
  return { canDecide: true, canApprove: true, limit, reason: null }
}

export async function assertReserveReviewer(t, actor, reserve, claim, { decision, amount }) {
  if (!actor.roles.includes(ROLES.OPS_MANAGER)) {
    throw forbidden('Only a Claims Manager can review reserves', 'APPROVAL_NOT_AUTHORISED')
  }
  if (reserve.set_by === actor.id) throw forbidden('You cannot review a reserve you set', 'SELF_APPROVAL_FORBIDDEN')
  if (decision === 'APPROVED' || decision === 'MODIFIED') {
    const limit = await effectiveLimit(t, actor.id, 'RESERVE', claim.segment, reserve.coverage_line)
    if (limit == null || Number(amount) > limit) {
      throw forbidden(
        `${money(amount)} exceeds your reserve authority of ${money(limit)}. Refer this reserve to a manager with higher authority.`,
        'APPROVAL_LIMIT_EXCEEDED',
      )
    }
    return limit
  }
  return null
}

const APPROVER_LABELS = { ADJUSTER: 'the assigned adjuster', OPS_MANAGER: 'a Claims Manager' }

/**
 * Who may decide a settlement step. An adjuster step belongs to the claim's
 * assigned adjuster, who also prepared the settlement; a Claims Manager step
 * needs someone other than the preparer.
 */
function settlementStepDenial(actor, payment, step, claim) {
  const notAuthorised = (message) => ({ code: 'APPROVAL_NOT_AUTHORISED', message })
  if (!actor.roles.includes(step.required_role)) return notAuthorised(`Requires approval by ${APPROVER_LABELS[step.required_role] || step.required_role}`)
  if (step.required_role === ROLES.ADJUSTER) {
    return claim.assigned_adjuster_id === actor.id ? null : notAuthorised('Only the assigned adjuster can approve this settlement')
  }
  return payment.requested_by === actor.id ? { code: 'SELF_APPROVAL_FORBIDDEN', message: 'You prepared this settlement' } : null
}

/** What the actor may do with the pending approval step of a settlement. */
export async function settlementStepCapability(t, actor, payment, step, claim) {
  if (!step) return { canDecide: false, canApprove: false, reason: 'No approval step is pending' }
  const denial = settlementStepDenial(actor, payment, step, claim)
  if (denial) return { canDecide: false, canApprove: false, reason: denial.message }
  const limit = await effectiveLimit(t, actor.id, 'SETTLEMENT', claim.segment)
  if (limit == null || Number(payment.amount) > limit) {
    return { canDecide: true, canApprove: false, limit, reason: `Exceeds your settlement authority of ${money(limit)}` }
  }
  return { canDecide: true, canApprove: true, limit, reason: null }
}

export async function assertSettlementApprover(t, actor, payment, step, claim, decision) {
  const denial = settlementStepDenial(actor, payment, step, claim)
  if (denial?.code === 'SELF_APPROVAL_FORBIDDEN') throw forbidden('The preparer of a settlement cannot approve it', denial.code)
  if (denial) throw forbidden(denial.message, denial.code)
  if (decision === 'APPROVED') {
    const limit = await effectiveLimit(t, actor.id, 'SETTLEMENT', claim.segment)
    if (limit == null || Number(payment.amount) > limit) {
      throw forbidden(
        `${money(payment.amount)} exceeds your settlement authority of ${money(limit)}. It needs a higher approver.`,
        'APPROVAL_LIMIT_EXCEEDED',
      )
    }
  }
}
