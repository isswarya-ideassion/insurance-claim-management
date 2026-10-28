import {
  ROLES,
  STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  INTAKE_CHECKLIST,
  OPEN_TASK_STATUSES,
  ACTIVE_RESERVE_STATUSES,
} from '../../../shared/constants.js'
import {
  findTransition,
  transitionsFrom,
  rolesCanExecute,
  allowedTargets,
  GUARD_DESCRIPTIONS,
} from '../../../shared/workflow.js'
import { AppError, businessRule, forbidden, validationError } from '../utils/errors.js'
import { hoursFromNow } from '../utils/format.js'
import { recordAudit } from './audit.service.js'
import { checkClaimEligibility } from './eligibility.service.js'
import { slaHours } from './config.service.js'
import { recordStageChange } from './sla.service.js'
import { assignIntakeOwner } from './intakeRouting.service.js'
import { notify, claimLink, userIdsWithRole } from './notification.service.js'

const DEFAULT_CUSTOMER_MESSAGES = {
  SUBMITTED: 'Your claim has been submitted and will be reviewed shortly.',
  POLICY_VERIFICATION: 'We are verifying your policy cover.',
  DOCUMENTS_REQUIRED: 'We need additional documents to continue processing your claim.',
  DOCUMENT_REVIEW: 'Your documents are being reviewed.',
  INVESTIGATION: 'An adjuster is assessing your claim.',
  SETTLEMENT_APPROVAL: 'Your claim assessment is complete and the settlement is awaiting approval.',
  PAYMENT_PENDING: 'Your settlement has been approved and payment is being processed.',
  PAYMENT_FAILED: 'There was a delay processing your payment. Our team is working on it.',
  PAID: 'Your settlement payment has been completed.',
  CLOSED: 'Your claim has been closed.',
  REJECTED: 'Your claim could not be approved. Please review the reasons provided.',
  WITHDRAWN: 'Your claim has been withdrawn.',
  REOPENED: 'Your claim has been reopened for further review.',
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Required artifacts of the claim that are neither accepted nor waived. */
export async function missingRequiredDocuments(t, claim) {
  const rows = await t.findMany('artifact_requirements', {
    where: { claim_id: claim.id, is_required: true, status: { nin: ['ACCEPTED', 'WAIVED'] } },
    columns: ['doc_type'],
  })
  return rows.map((r) => r.doc_type)
}

export async function hasActiveComplianceHold(t, claimId) {
  return (await t.count('reviews', { claim_id: claimId, checkpoint_type: 'COMPLIANCE', hold_active: true })) > 0
}

const GUARDS = {
  async policyEligible(t, claim) {
    const result = await checkClaimEligibility(t, claim)
    return result.eligible || result.reasons.join('; ')
  },
  declarationAccepted: (t, claim) => Boolean(claim.declaration_accepted),
  coverageConfirmed: (t, claim) => claim.coverage_result === 'COVERED',
  async payeeVerified(t, claim) {
    const policy = claim.policy_id ? await t.findOne('policies', { id: claim.policy_id }, { columns: ['payee_id'] }) : null
    const payee = policy?.payee_id ? await t.findOne('payees', { id: policy.payee_id }, { columns: ['verification_status', 'bank_details_encrypted'] }) : null
    if (!payee || !payee.bank_details_encrypted) return 'Payee bank details have not been collected yet'
    return payee.verification_status === 'VERIFIED' || 'Payee bank details are recorded but not yet verified'
  },
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
  async evaluationSubmitted(t, claim) {
    return (await t.count('evaluations', { claim_id: claim.id, status: { in: ['SUBMITTED', 'APPROVED'] } })) > 0
  },
  async reservePendingReview(t, claim) {
    return (await t.count('reserves', { claim_id: claim.id, approval_status: 'PENDING_REVIEW' })) > 0
  },
  async reservePosted(t, claim) {
    const posted = await t.count('reserves', { claim_id: claim.id, approval_status: { in: ACTIVE_RESERVE_STATUSES }, amount: { gt: 0 } })
    const pending = await t.count('reserves', { claim_id: claim.id, approval_status: 'PENDING_REVIEW' })
    return (posted > 0 && pending === 0) || (pending > 0 ? 'A reserve is still awaiting manager review' : false)
  },
  async reserveApproved(t, claim) {
    return (await t.count('reserves', { claim_id: claim.id, approval_status: { in: ACTIVE_RESERVE_STATUSES } })) > 0
  },
  async complianceCleared(t, claim) {
    const latest = await t.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE' }, { orderBy: [['created_at', 'desc']] })
    return ['CLEARED', 'EXCEPTION_APPROVED'].includes(latest?.status)
  },
  async noActiveComplianceHold(t, claim) {
    return !(await hasActiveComplianceHold(t, claim.id))
  },
  async settlementApproved(t, claim) {
    return (await t.count('payments', { claim_id: claim.id, status: 'PENDING' })) > 0
  },
  async paymentCompleted(t, claim) {
    return (await t.count('payments', { claim_id: claim.id, status: { in: ['PAID', 'RECONCILED'] } })) > 0
  },
  async noOpenMandatoryTasks(t, claim) {
    const open = await t.count('tasks', { claim_id: claim.id, blocking: true, status: { in: OPEN_TASK_STATUSES } })
    return open === 0 || `${open} blocking task(s) still open`
  },
  async noPendingApprovals(t, claim) {
    const reserves = await t.count('reserves', { claim_id: claim.id, approval_status: 'PENDING_REVIEW' })
    const settlements = await t.count('payments', { claim_id: claim.id, status: 'PENDING_APPROVAL' })
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
    return acting.includes(ROLES.CLIENT) ? null : 'You cannot act as staff on your own claim'
  }
  const staffActing = acting.filter((r) => r !== ROLES.CLIENT)
  if (staffActing.length === 0) return 'Clients can only act on their own claims'
  if (staffActing.every((r) => r === ROLES.ADJUSTER) && claim.assigned_adjuster_id !== actor.id) {
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
  const dueDate = await recordStageChange(t, { ...claim, ...patch }, toStatus, now)
  const update = { ...patch, status: toStatus, due_date: dueDate, updated_by: actor?.id || null }
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

  // stage and reopen_count are maintained by the claims_enforce_status_rules trigger.
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
    metadata: { from, to: toStatus, reason, system, stage: updated.stage },
  })

  await applySideEffects(ctx, t, updated, { from, to: toStatus, rule, reason })

  if (customerVisible && message && updated.claim_number) {
    const type =
      toStatus === 'REJECTED' ? 'CLAIM_REJECTED'
        : toStatus === 'CLOSED' ? 'CLAIM_CLOSED'
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

async function addTask(t, claim, task) {
  return t.insert('tasks', {
    claim_id: claim.id,
    priority: claim.priority,
    source_stage: claim.stage,
    ...task,
  })
}

/** Releases what is left of each reserve line when a paid claim is closed (reserve ledger reaches zero). */
async function releaseReserves(t, claim, actorId) {
  const active = await t.findMany('reserves', {
    where: { claim_id: claim.id, approval_status: { in: ACTIVE_RESERVE_STATUSES }, amount: { gt: 0 } },
  })
  for (const r of active) {
    await t.updateById('reserves', r.id, { approval_status: 'SUPERSEDED' })
    await t.insert('reserves', {
      claim_id: claim.id,
      evaluation_id: r.evaluation_id,
      coverage_line: r.coverage_line,
      amount: 0,
      prev_amount: r.amount,
      currency: r.currency,
      reason_code: 'CLOSURE_RELEASE',
      notes: 'Remaining reserve released at closure',
      set_by: actorId,
      created_by: actorId,
      authority_ok: true,
      approval_status: 'POSTED',
    })
  }
}

async function applySideEffects(ctx, t, claim, { from, to, rule, reason }) {
  const actorId = ctx.actor?.id || null

  if (to === 'CLOSED' && rule.closure === 'PERMITTED_OUTCOME') {
    await t.update(
      'tasks',
      { claim_id: claim.id, status: { in: OPEN_TASK_STATUSES } },
      { status: 'CANCELLED', completed_at: new Date(), completed_by: actorId },
    )
    await t.update(
      'artifact_requirements',
      { claim_id: claim.id, status: { in: ['MISSING', 'REQUESTED'] } },
      { status: 'CANCELLED', closed_at: new Date() },
    )
  }

  if (to === 'CLOSED' && rule.closure === 'COMPLETED' && actorId) {
    await releaseReserves(t, claim, actorId)
  }

  if (to === 'CLOSED') {
    await t.update('closure_requests', { claim_id: claim.id, status: 'PENDING' }, { status: 'APPROVED', decided_by: actorId, decided_at: new Date() })
  }

  if (to === 'COMPLIANCE_REVIEW') {
    const open = await t.count('reviews', {
      claim_id: claim.id,
      checkpoint_type: 'COMPLIANCE',
      status: { in: ['PENDING', 'IN_REVIEW', 'HOLD', 'ESCALATED'] },
    })
    if (open === 0) {
      await t.insert('reviews', {
        claim_id: claim.id,
        checkpoint_type: 'COMPLIANCE',
        subject_type: 'claim',
        subject_id: claim.id,
        status: 'PENDING',
        created_by: actorId,
      })
    }
    await notify(ctx, t, {
      recipientIds: await userIdsWithRole(t, ROLES.COMPLIANCE_SECURITY),
      claimId: claim.id,
      type: 'APPROVAL_REQUIRED',
      title: `Compliance review required: ${claim.claim_number}`,
      message: `Claim ${claim.claim_number} is ready for compliance review.`,
      link: claimLink(claim, false),
      email: false,
    })
  }

  if (to === 'ADJUSTER_ASSIGNMENT') {
    const existing = await t.count('tasks', { claim_id: claim.id, type: 'ASSIGN_ADJUSTER', status: { in: OPEN_TASK_STATUSES } })
    if (existing === 0) {
      await addTask(t, claim, {
        title: `Assign an adjuster to ${claim.claim_number}`,
        type: 'ASSIGN_ADJUSTER',
        // The claim's Claims Operations Manager routes it to an adjuster.
        owner_user_id: claim.assigned_owner_id || null,
        owner_role: ROLES.CLAIMS_OPS_MANAGER,
        blocking: true,
        due_at: hoursFromNow((await slaHours(t, claim.segment, 'ADJUSTER_ASSIGNMENT')) || 24),
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
    // New claims go straight to a named Claims Operations Manager (lowest workload).
    const ownerId = await assignIntakeOwner(ctx, t, claim)
    await addTask(t, claim, {
      title: `Intake review for ${claim.claim_number}`,
      description: 'Verify coverage, complete the intake checklist, collect and verify the payee details, and route the claim.',
      type: 'INTAKE_REVIEW',
      owner_user_id: ownerId,
      owner_role: ROLES.CLAIMS_OPS_MANAGER,
      blocking: true,
      due_at: hoursFromNow((await slaHours(t, claim.segment, 'SUBMITTED')) || 24),
      created_by: actorId,
    })
  }

  if (to === 'DOCUMENT_REVIEW' || to === 'DOCUMENTS_REQUIRED' || to === 'REJECTED') {
    await t.update(
      'tasks',
      { claim_id: claim.id, type: { in: ['INTAKE_REVIEW', 'POLICY_CHECK'] }, status: { in: OPEN_TASK_STATUSES } },
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
