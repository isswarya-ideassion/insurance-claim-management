import { ROLES } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

// Claims an adjuster may ask to close: paid or denied (PRD 3.9).
const CLOSABLE_STATUSES = ['PAID', 'REJECTED']

export async function listClosureRequests(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'recovery')
  const rows = await ctx.db.findMany('closure_requests', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.decided_by]))
  return rows.map((r) => ({ ...r, requested_by_name: nameOf(names, r.requested_by), decided_by_name: nameOf(names, r.decided_by) }))
}

/** The assigned adjuster asks the Claims Manager to close a paid or denied claim. */
export async function requestClosure(ctx, claimId, { reason }) {
  requirePermission(ctx.actor, 'claims.requestClosure')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (claim.assigned_adjuster_id !== ctx.actor.id) throw forbidden('Only the assigned adjuster can request closure')
    if (!CLOSABLE_STATUSES.includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Closure can be requested once the claim is paid or denied')
    }
    if (await t.findOne('closure_requests', { claim_id: claimId, status: 'PENDING' })) {
      throw businessRule('CLOSURE_ALREADY_REQUESTED', 'A closure request for this claim is already pending')
    }
    const request = await t.insert('closure_requests', { claim_id: claimId, requested_by: ctx.actor.id, reason })
    await recordAudit(t, ctx.actor, { action: 'CLOSURE_REQUESTED', entityType: 'closure_request', entityId: request.id, claimId, after: request })
    await notify(ctx, t, {
      recipientIds: await userIdsWithRole(t, ROLES.OPS_MANAGER),
      claimId,
      type: 'APPROVAL_REQUIRED',
      title: `Closure requested: ${claim.claim_number}`,
      message: reason,
      link: `${claimLink(claim, false)}?tab=recovery`,
    })
    return request
  })
}

/**
 * Claims Manager decision (reverse-review checkpoint). Approval closes the claim
 * through the workflow, so every closure guard still applies.
 */
export async function decideClosure(ctx, requestId, { decision, comment }) {
  requirePermission(ctx.actor, 'claims.decideClosure')
  return ctx.db.tx(async (t) => {
    const request = await t.findOne('closure_requests', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Closure request not found')
    await loadAccessibleClaim(t, ctx.actor, request.claim_id)
    const claim = await lockClaim(t, request.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (request.status !== 'PENDING') throw businessRule('ALREADY_DECIDED', 'This closure request has already been decided')
    if (request.requested_by === ctx.actor.id) throw forbidden('You cannot decide your own closure request', 'SELF_APPROVAL_FORBIDDEN')

    const now = new Date()
    await t.insert('reviews', {
      claim_id: claim.id,
      checkpoint_type: 'CLOSURE',
      subject_type: 'closure_request',
      subject_id: request.id,
      status: 'DECIDED',
      outcome: decision,
      requested_by: request.requested_by,
      reviewer_id: ctx.actor.id,
      decided_by: ctx.actor.id,
      comments: comment || null,
      reviewed_at: now,
    })
    const updated = await t.updateById('closure_requests', request.id, {
      status: decision,
      decided_by: ctx.actor.id,
      decided_at: now,
      decision_comment: comment || null,
    })
    let claimAfter = claim
    if (decision === 'APPROVED') {
      claimAfter = await transitionClaim(ctx, t, claim, 'CLOSED', { reason: comment || request.reason })
    }
    await recordAudit(t, ctx.actor, {
      action: decision === 'APPROVED' ? 'CLOSURE_APPROVED' : 'CLOSURE_REJECTED',
      entityType: 'closure_request',
      entityId: request.id,
      claimId: claim.id,
      before: request,
      after: updated,
      metadata: { comments: comment },
    })
    await notify(ctx, t, {
      recipientIds: [request.requested_by],
      claimId: claim.id,
      type: decision === 'REJECTED' ? 'APPROVAL_REJECTED' : 'APPROVAL_DECISION',
      title: `Closure ${decision.toLowerCase()}: ${claim.claim_number}`,
      message: comment || `Your closure request was ${decision.toLowerCase()}.`,
      link: claimLink(claim, false),
      email: false,
    })
    return { closureRequest: updated, claim: claimAfter }
  })
}

// ---------------------------------------------------------------------------
// Recoveries: subrogation and salvage
// ---------------------------------------------------------------------------
export async function listRecoveries(ctx, claimId) {
  requirePermission(ctx.actor, 'recoveries.view')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  if (!ctx.actor.roles.includes(ROLES.PAYMENT_OPERATOR)) requireTab(ctx.actor, claim, 'recovery')
  const rows = await ctx.db.findMany('recoveries', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.created_by, r.updated_by]))
  return rows.map((r) => ({ ...r, created_by_name: nameOf(names, r.created_by), updated_by_name: nameOf(names, r.updated_by) }))
}

export async function createRecovery(ctx, claimId, input) {
  requirePermission(ctx.actor, 'recoveries.write')
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (ctx.actor.roles.every((r) => r === ROLES.ADJUSTER) && claim.assigned_adjuster_id !== ctx.actor.id) {
      throw forbidden('Only the assigned adjuster can record recoveries on this claim')
    }
    if (['DRAFT', 'WITHDRAWN'].includes(claim.status)) throw businessRule('INVALID_STAGE', 'Recoveries need a submitted claim')
    const recovery = await t.insert('recoveries', {
      claim_id: claimId,
      type: input.type,
      target_party: input.targetParty || null,
      description: input.description || null,
      expected_amount: input.expectedAmount ?? null,
      deadline: input.deadline || null,
      status: 'IDENTIFIED',
      created_by: ctx.actor.id,
      updated_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'RECOVERY_RECORDED', entityType: 'recovery', entityId: recovery.id, claimId, after: recovery })
    return recovery
  })
}

export async function updateRecovery(ctx, id, input) {
  requirePermission(ctx.actor, 'recoveries.write')
  return ctx.db.tx(async (t) => {
    const recovery = await t.findOne('recoveries', { id }, { forUpdate: true })
    if (!recovery) throw notFound('Recovery not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, recovery.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    const patch = { updated_by: ctx.actor.id }
    if (input.status) patch.status = input.status
    if (input.recoveredAmount !== undefined) patch.recovered_amount = input.recoveredAmount
    if (input.expectedAmount !== undefined) patch.expected_amount = input.expectedAmount
    if (input.targetParty !== undefined) patch.target_party = input.targetParty
    if (input.deadline !== undefined) patch.deadline = input.deadline
    if (input.description !== undefined) patch.description = input.description
    const updated = await t.updateById('recoveries', id, patch)
    await recordAudit(t, ctx.actor, { action: 'RECOVERY_UPDATED', entityType: 'recovery', entityId: id, claimId: recovery.claim_id, before: recovery, after: updated })
    return updated
  })
}
