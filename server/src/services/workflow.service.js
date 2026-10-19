import {
  ROLES,
  STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  INTAKE_CHECKLIST,
  REQUIRED_DOCUMENTS,
  OPEN_TASK_STATUSES,
} from '../../../shared/constants.js'
import {
  findTransition,
  transitionsFrom,
  rolesCanExecute,
  allowedTargets,
  GUARD_DESCRIPTIONS,
  STATUS_SLA_HOURS,
} from '../../../shared/workflow.js'
import { AppError, businessRule, forbidden, validationError } from '../utils/errors.js'
import { hoursFromNow } from '../utils/format.js'
import { recordAudit } from './audit.service.js'
import { checkClaimEligibility } from './eligibility.service.js'
import { notify, claimLink, userIdsWithRole } from './notification.service.js'

const DEFAULT_CUSTOMER_MESSAGES = {
  SUBMITTED: 'Your claim has been submitted and will be reviewed shortly.',
  POLICY_VERIFICATION: 'We are verifying your policy details.',
  DOCUMENTS_REQUIRED: 'We need additional documents to continue processing your claim.',
  DOCUMENT_REVIEW: 'Your documents are being reviewed.',
  INVESTIGATION: 'An adjuster is assessing your claim.',
  SETTLEMENT_APPROVAL: 'Your claim assessment is complete and the settlement is awaiting approval.',
  PAYMENT_PENDING: 'Your settlement has been approved and payment is being processed.',
  PAYMENT_FAILED: 'There was a delay processing your payment. Our team is working on it.',
  PAID: 'Your settlement payment has been completed.',
  CLOSED: 'Your claim has been closed.',
  REJECTED: 'Your claim could not be approved. Please review the details provided.',
  WITHDRAWN: 'Your claim has been withdrawn.',
  REOPENED: 'Your claim has been reopened for further review.',
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
export async function missingRequiredDocuments(t, claim) {
  const required = REQUIRED_DOCUMENTS[claim.claim_type] || []
  if (required.length === 0) return []
  const accepted = await t.query(
    `select distinct category from public.documents where claim_id = $1 and status = 'ACCEPTED'`,
    [claim.id],
  )
  const have = new Set(accepted.map((r) => r.category))
  return required.filter((c) => !have.has(c))
}

export async function hasActiveComplianceHold(t, claimId) {
  return (await t.count('compliance_reviews', { claim_id: claimId, hold_active: true })) > 0
}

const GUARDS = {
  async policyEligible(t, claim) {
    const result = await checkClaimEligibility(t, claim)
    return result.eligible || result.reasons.join('; ')
  },
  declarationAccepted: (t, claim) => Boolean(claim.declaration_accepted),
  policyVerified: (t, claim) => claim.policy_verified === true,
  intakeChecklistComplete(t, claim) {
    const missing = INTAKE_CHECKLIST.filter((i) => !claim.intake_checklist?.[i.key]?.checked)
    return missing.length === 0 || `Incomplete intake items: ${missing.map((m) => m.label).join(', ')}`
  },
  async hasDocumentsAwaitingReview(t, claim) {
    return (await t.count('documents', { claim_id: claim.id, status: 'PENDING_REVIEW' })) > 0
  },
  async requiredDocumentsAccepted(t, claim) {
    if (claim.document_exception_at) return true
    const missing = await missingRequiredDocuments(t, claim)
    return missing.length === 0 || `Required documents not yet accepted: ${missing.join(', ')}`
  },
  adjusterAssigned: (t, claim) => Boolean(claim.assigned_adjuster_id),
  async assessmentSubmitted(t, claim) {
    return (await t.count('assessments', { claim_id: claim.id, status: 'SUBMITTED' })) > 0
  },
  async reservePending(t, claim) {
    return (await t.count('reserves', { claim_id: claim.id, status: 'PENDING_APPROVAL' })) > 0
  },
  async reserveApproved(t, claim) {
    return (await t.count('reserves', { claim_id: claim.id, status: 'APPROVED' })) > 0
  },
  async complianceCleared(t, claim) {
    const latest = await t.findOne('compliance_reviews', { claim_id: claim.id }, { orderBy: [['created_at', 'desc']] })
    return ['CLEARED', 'EXCEPTION_APPROVED'].includes(latest?.status)
  },
  async noActiveComplianceHold(t, claim) {
    return !(await hasActiveComplianceHold(t, claim.id))
  },
  async settlementApproved(t, claim) {
    return (await t.count('settlements', { claim_id: claim.id, status: 'APPROVED' })) > 0
  },
  async paymentCompleted(t, claim) {
    return (await t.count('payments', { claim_id: claim.id, status: { in: ['PAID', 'RECONCILED'] } })) > 0
  },
  async noOpenMandatoryTasks(t, claim) {
    const open = await t.count('tasks', { claim_id: claim.id, is_mandatory: true, status: { in: OPEN_TASK_STATUSES } })
    return open === 0 || `${open} mandatory task(s) still open`
  },
  async noPendingApprovals(t, claim) {
    const reserves = await t.count('reserves', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    const settlements = await t.count('settlements', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
    return reserves + settlements === 0
  },
  resumesToHeldStatus: (t, claim, target) =>
    target === claim.hold_from_status || `This claim can only resume to ${STATUS_LABELS[claim.hold_from_status]}`,
}

export async function evaluateGuards(t, claim, rule) {
  const results = []
  for (const name of rule.guards || []) {
    const outcome = await GUARDS[name](t, claim, rule.to)
    const passed = outcome === true
    results.push({
      guard: name,
      passed,
      message: passed ? null : typeof outcome === 'string' ? outcome : GUARD_DESCRIPTIONS[name],
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// Authorization for a specific transition
// ---------------------------------------------------------------------------
function authorizeActor(rule, claim, actor) {
  const acting = rolesCanExecute(rule, actor.roles)
  if (acting.length === 0) {
    return `Only ${rule.roles.join(', ')} can perform "${rule.label}"`
  }
  const isOwner = claim.customer_id === actor.id
  if (isOwner) {
    return acting.includes(ROLES.CUSTOMER) ? null : 'You cannot act as staff on your own claim'
  }
  const staffActing = acting.filter((r) => r !== ROLES.CUSTOMER)
  if (staffActing.length === 0) return 'Customers can only act on their own claims'
  if (staffActing.every((r) => r === ROLES.CLAIMS_ADJUSTER) && claim.assigned_adjuster_id !== actor.id) {
    return 'Only the assigned adjuster can perform this action'
  }
  return null
}

/** Lists transitions the actor could attempt from the claim's current status, with guard outcomes. */
export async function availableTransitions(t, claim, actor) {
  const out = []
  for (const rule of transitionsFrom(claim.status)) {
    if (rule.systemOnly) continue
    if (authorizeActor(rule, claim, actor)) continue
    if (rule.resume && rule.to !== claim.hold_from_status) continue
    const guards = await evaluateGuards(t, claim, rule)
    out.push({
      to: rule.to,
      label: rule.label,
      requiresReason: Boolean(rule.requiresReason),
      allowed: guards.every((g) => g.passed),
      blockedBy: guards.filter((g) => !g.passed),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Transition execution
// ---------------------------------------------------------------------------
/**
 * Validates and applies a status transition. Must run inside a transaction
 * (`t`) with the claim row locked by the caller (findOne ... { forUpdate: true }).
 *
 * options.system  -> internal service transition (e.g. payment results)
 * options.patch   -> extra claim columns to update atomically with the status
 */
export async function transitionClaim(ctx, t, claim, toStatus, options = {}) {
  if (!t.inTransaction) throw new Error('transitionClaim must be called inside a transaction')
  const { reason = null, customerMessage = null, system = false, patch = {} } = options
  const actor = ctx.actor
  const from = claim.status
  const rule = findTransition(from, toStatus)
  const ref = claim.claim_number || 'draft claim'

  if (!rule) {
    const allowed = allowedTargets(from)
    throw new AppError(
      422,
      'INVALID_TRANSITION',
      `Claim ${ref} cannot move from ${STATUS_LABELS[from]} to ${STATUS_LABELS[toStatus] || toStatus}. ` +
        (allowed.length ? `Permitted next statuses: ${allowed.map((s) => STATUS_LABELS[s]).join(', ')}.` : 'No further transitions are permitted.'),
      { from, to: toStatus, allowed },
    )
  }
  if (rule.systemOnly && !system) {
    throw forbidden(`"${rule.label}" is recorded automatically by the payment service`, 'SYSTEM_TRANSITION_ONLY')
  }
  if (!system) {
    const denial = authorizeActor(rule, claim, actor)
    if (denial) throw forbidden(denial, 'TRANSITION_NOT_PERMITTED')
  }
  if (rule.requiresReason && !String(reason || '').trim()) {
    throw validationError(`A reason is required to "${rule.label}"`)
  }

  const guards = await evaluateGuards(t, claim, rule)
  const failed = guards.filter((g) => !g.passed)
  if (failed.length) {
    throw businessRule(
      'WORKFLOW_GUARD_FAILED',
      `Cannot move claim ${ref} to ${STATUS_LABELS[toStatus]}: ${failed.map((f) => f.message).join(' ')}`,
      { from, to: toStatus, failures: failed },
    )
  }

  const now = new Date()
  const update = {
    ...patch,
    status: toStatus,
    due_date: STATUS_SLA_HOURS[toStatus] ? hoursFromNow(STATUS_SLA_HOURS[toStatus], now) : null,
  }
  if (toStatus === 'ON_HOLD') update.hold_from_status = from
  if (from === 'ON_HOLD') update.hold_from_status = null
  if (toStatus === 'REJECTED') update.rejection_reason = reason
  if (toStatus === 'CLOSED') {
    update.closed_at = now
    update.closure_reason = reason || (rule.closure === 'COMPLETED' ? 'Settled and paid' : `Closed after ${STATUS_LABELS[from]}`)
  }
  if (toStatus === 'REOPENED') {
    update.closed_at = null
    update.closure_reason = null
  }

  const updated = await t.updateById('claims', claim.id, update)

  const holdRelated = toStatus === 'ON_HOLD' || from === 'ON_HOLD'
  const customerVisible = !holdRelated && CUSTOMER_STATUS_LABELS[from] !== CUSTOMER_STATUS_LABELS[toStatus]
  const message = customerVisible ? customerMessage || DEFAULT_CUSTOMER_MESSAGES[toStatus] || null : null

  await t.insert('claim_status_history', {
    claim_id: claim.id,
    from_status: from,
    to_status: toStatus,
    changed_by: actor?.id || null,
    reason,
    customer_message: message,
    customer_visible: customerVisible,
  })

  await recordAudit(t, actor, {
    action: 'CLAIM_STATUS_CHANGED',
    entityType: 'claim',
    entityId: claim.id,
    claimId: claim.id,
    before: claim,
    after: updated,
    metadata: { from, to: toStatus, reason, system },
  })

  await applySideEffects(ctx, t, updated, { from, to: toStatus, rule, reason })

  if (customerVisible && message && updated.claim_number) {
    const type =
      toStatus === 'CLOSED' ? 'CLAIM_CLOSED'
        : toStatus === 'DOCUMENTS_REQUIRED' ? 'DOCUMENTS_REQUIRED'
          : toStatus === 'INVESTIGATION' ? 'INVESTIGATION_UPDATE'
            : toStatus === 'SUBMITTED' ? 'CLAIM_SUBMITTED'
              : toStatus === 'PAID' ? 'PAYMENT_SUCCEEDED'
                : toStatus === 'PAYMENT_FAILED' ? 'PAYMENT_FAILED'
                  : 'CLAIM_STATUS_CHANGED'
    await notify(ctx, t, {
      recipientIds: [updated.customer_id],
      claimId: claim.id,
      type,
      title: `Claim ${updated.claim_number}: ${CUSTOMER_STATUS_LABELS[toStatus]}`,
      message: reason && ['REJECTED', 'DOCUMENTS_REQUIRED'].includes(toStatus) ? `${message} ${reason}` : message,
      link: claimLink(updated, true),
    })
  }

  return updated
}

async function applySideEffects(ctx, t, claim, { from, to, rule, reason }) {
  const actorId = ctx.actor?.id || null

  if (to === 'CLOSED' && rule.closure === 'PERMITTED_OUTCOME') {
    await t.update(
      'tasks',
      { claim_id: claim.id, status: { in: OPEN_TASK_STATUSES } },
      { status: 'CANCELLED', completed_at: new Date(), completed_by: actorId },
    )
    await t.update('information_requests', { claim_id: claim.id, status: 'OPEN' }, { status: 'CANCELLED', closed_at: new Date() })
  }

  if (to === 'COMPLIANCE_REVIEW') {
    const open = await t.count('compliance_reviews', { claim_id: claim.id, status: { in: ['PENDING', 'IN_REVIEW', 'HOLD', 'ESCALATED'] } })
    if (open === 0) {
      await t.insert('compliance_reviews', { claim_id: claim.id, status: 'PENDING', created_by: actorId })
    }
    await notify(ctx, t, {
      recipientIds: await userIdsWithRole(t, ROLES.COMPLIANCE_OFFICER),
      claimId: claim.id,
      type: 'APPROVAL_REQUIRED',
      title: `Compliance review required: ${claim.claim_number}`,
      message: `Claim ${claim.claim_number} is ready for compliance review.`,
      link: claimLink(claim, false),
      email: false,
    })
  }

  if (to === 'ADJUSTER_ASSIGNMENT') {
    const existing = await t.count('tasks', { claim_id: claim.id, task_type: 'ASSIGN_ADJUSTER', status: { in: OPEN_TASK_STATUSES } })
    if (existing === 0) {
      await t.insert('tasks', {
        claim_id: claim.id,
        title: `Assign an adjuster to ${claim.claim_number}`,
        task_type: 'ASSIGN_ADJUSTER',
        assigned_role: ROLES.CLAIMS_MANAGER,
        priority: claim.priority,
        is_mandatory: true,
        due_at: hoursFromNow(STATUS_SLA_HOURS.ADJUSTER_ASSIGNMENT),
        created_by: actorId,
      })
    }
  }

  if (to === 'ON_HOLD') {
    await notify(ctx, t, {
      recipientIds: [claim.assigned_owner_id, claim.assigned_adjuster_id].filter((id) => id && id !== actorId),
      claimId: claim.id,
      type: 'CLAIM_STATUS_CHANGED',
      title: `Claim ${claim.claim_number} placed on hold`,
      message: `Reason: ${reason}`,
      link: claimLink(claim, false),
      email: false,
    })
  }

  if (from === 'DRAFT' && to === 'SUBMITTED') {
    await t.insert('tasks', {
      claim_id: claim.id,
      title: `Intake review for ${claim.claim_number}`,
      description: 'Verify policy, complete the intake checklist and route the claim.',
      task_type: 'INTAKE_REVIEW',
      assigned_role: ROLES.CLAIMS_OPERATIONS,
      priority: claim.priority,
      is_mandatory: true,
      due_at: hoursFromNow(STATUS_SLA_HOURS.SUBMITTED),
      created_by: actorId,
    })
  }

  if (to === 'DOCUMENT_REVIEW' || to === 'DOCUMENTS_REQUIRED' || to === 'REJECTED') {
    await t.update(
      'tasks',
      { claim_id: claim.id, task_type: { in: ['INTAKE_REVIEW', 'POLICY_CHECK'] }, status: { in: OPEN_TASK_STATUSES } },
      { status: 'DONE', completed_at: new Date(), completed_by: actorId },
    )
  }
}

/** Locks and returns a claim row inside a transaction. */
export async function lockClaim(t, claimId) {
  const claim = await t.findOne('claims', { id: claimId }, { forUpdate: true })
  if (!claim) throw new AppError(404, 'NOT_FOUND', 'Claim not found')
  return claim
}
