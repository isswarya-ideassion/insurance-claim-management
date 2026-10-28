import { ROLES, INVESTIGATION_CHECKLIST, ACTIVE_RESERVE_STATUSES, COVERAGE_LINES, defaultCoverageLine } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { effectiveLimit } from '../../services/config.service.js'
import { policyForClaim } from '../../services/eligibility.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { formatInr, roundMoney } from '../../utils/format.js'

const FIELD_MAP = {
  checklist: 'checklist',
  findings: 'findings',
  evidence: 'evidence',
  lossValue: 'loss_value',
  liabilityPct: 'liability_pct',
  recommendedSettlement: 'recommended_settlement',
  decision: 'decision',
  internalNotes: 'internal_notes',
}

function mapFields(input) {
  const out = {}
  for (const [k, col] of Object.entries(FIELD_MAP)) if (input[k] !== undefined) out[col] = input[k]
  return out
}

export async function listEvaluations(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'investigation')
  const rows = await ctx.db.findMany('evaluations', { where: { claim_id: claimId }, orderBy: [['version_no', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.adjuster_id, r.reviewed_by]))
  return rows.map((r) => ({ ...r, adjuster_name: nameOf(names, r.adjuster_id), reviewed_by_name: nameOf(names, r.reviewed_by) }))
}

function requireAssignedAdjuster(ctx, claim) {
  requirePermission(ctx.actor, 'evaluations.write')
  requireNotOwnClaim(ctx.actor, claim)
  if (claim.assigned_adjuster_id !== ctx.actor.id) throw forbidden('Only the assigned adjuster can work on this evaluation')
}

export async function createEvaluation(ctx, claimId, input) {
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireAssignedAdjuster(ctx, claim)
    if (claim.status !== 'INVESTIGATION') throw businessRule('INVALID_STAGE', 'Evaluations can only be started during investigation')

    const latest = await t.findOne('evaluations', { claim_id: claimId }, { orderBy: [['version_no', 'desc']], forUpdate: true })
    if (latest && ['DRAFT', 'SUBMITTED'].includes(latest.status)) {
      throw businessRule('EVALUATION_IN_PROGRESS', `Version ${latest.version_no} is already ${latest.status.toLowerCase()}`, { evaluationId: latest.id })
    }
    const carry = latest
      ? {
          checklist: latest.checklist,
          findings: latest.findings,
          evidence: latest.evidence,
          loss_value: latest.loss_value,
          liability_pct: latest.liability_pct,
          recommended_settlement: latest.recommended_settlement,
          decision: latest.decision,
          internal_notes: latest.internal_notes,
        }
      : { loss_value: claim.estimated_loss }
    const evaluation = await t.insert('evaluations', {
      claim_id: claimId,
      version_no: (latest?.version_no || 0) + 1,
      adjuster_id: ctx.actor.id,
      status: 'DRAFT',
      ...carry,
      ...mapFields(input),
    })
    if (latest && latest.status === 'APPROVED') await t.updateById('evaluations', latest.id, { status: 'SUPERSEDED' })
    await recordAudit(t, ctx.actor, { action: 'EVALUATION_CREATED', entityType: 'evaluation', entityId: evaluation.id, claimId, after: evaluation })
    return evaluation
  })
}

export async function updateEvaluation(ctx, id, input) {
  return ctx.db.tx(async (t) => {
    const evaluation = await t.findOne('evaluations', { id }, { forUpdate: true })
    if (!evaluation) throw notFound('Evaluation not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, evaluation.claim_id)
    requireAssignedAdjuster(ctx, claim)
    if (evaluation.status !== 'DRAFT') throw businessRule('EVALUATION_LOCKED', 'Only draft evaluations can be edited')
    const updated = await t.updateById('evaluations', id, mapFields(input))
    await recordAudit(t, ctx.actor, { action: 'EVALUATION_UPDATED', entityType: 'evaluation', entityId: id, claimId: claim.id, before: evaluation, after: updated })
    return updated
  })
}

/**
 * Records a new reserve for a coverage line as a ledger entry. Within the
 * adjuster's authority it is posted; above it, it waits for manager review.
 * Earlier active or pending entries of the line are superseded.
 */
export async function setReserve(ctx, t, claim, { evaluationId = null, coverageLine, amount, reasonCode = 'INITIAL', notes = null }) {
  const line = coverageLine || defaultCoverageLine(claim.claim_type)
  if (!(COVERAGE_LINES[claim.claim_type] || [line]).includes(line)) {
    throw validationError(`Coverage line ${line} does not apply to a ${claim.claim_type} claim`)
  }
  const limit = await effectiveLimit(t, ctx.actor.id, 'RESERVE', claim.segment, line)
  const withinAuthority = limit != null && Number(amount) <= limit
  const previous = await t.findMany('reserves', {
    where: { claim_id: claim.id, coverage_line: line, approval_status: { in: [...ACTIVE_RESERVE_STATUSES, 'PENDING_REVIEW'] } },
    orderBy: [['effective_at', 'desc']],
  })
  for (const p of previous) await t.updateById('reserves', p.id, { approval_status: 'SUPERSEDED', updated_by: ctx.actor.id })
  const prevAmount = previous.find((p) => ACTIVE_RESERVE_STATUSES.includes(p.approval_status))?.amount ?? null
  const reserve = await t.insert('reserves', {
    claim_id: claim.id,
    evaluation_id: evaluationId,
    coverage_line: line,
    amount: roundMoney(amount),
    prev_amount: prevAmount,
    reason_code: reasonCode,
    notes,
    set_by: ctx.actor.id,
    created_by: ctx.actor.id,
    authority_ok: withinAuthority,
    approval_status: withinAuthority ? 'POSTED' : 'PENDING_REVIEW',
  })
  await recordAudit(t, ctx.actor, {
    action: withinAuthority ? 'RESERVE_POSTED' : 'RESERVE_ESCALATED',
    entityType: 'reserve',
    entityId: reserve.id,
    claimId: claim.id,
    after: reserve,
    metadata: { coverageLine: line, authorityLimit: limit, prevAmount },
  })
  if (!withinAuthority) {
    await notify(ctx, t, {
      recipientIds: (await userIdsWithRole(t, ROLES.OPS_MANAGER)).filter((m) => m !== ctx.actor.id),
      claimId: claim.id,
      type: 'APPROVAL_REQUIRED',
      title: `Reserve review required: ${claim.claim_number}`,
      message: `Reserve of ${formatInr(reserve.amount)} on ${line.replace(/_/g, ' ').toLowerCase()} exceeds the adjuster's authority${limit != null ? ` of ${limit.toFixed(2)}` : ''}.`,
      link: `/claims/${claim.id}?tab=reserves`,
    })
  }
  return { reserve, withinAuthority, limit }
}

export async function submitEvaluation(ctx, id, { reserveAmount, reserveReason, coverageLine }) {
  return ctx.db.tx(async (t) => {
    const evaluation = await t.findOne('evaluations', { id }, { forUpdate: true })
    if (!evaluation) throw notFound('Evaluation not found')
    await loadAccessibleClaim(t, ctx.actor, evaluation.claim_id)
    const claim = await lockClaim(t, evaluation.claim_id)
    requireAssignedAdjuster(ctx, claim)
    if (evaluation.status !== 'DRAFT') throw businessRule('EVALUATION_LOCKED', 'This evaluation has already been submitted')
    if (claim.status !== 'INVESTIGATION') throw businessRule('INVALID_STAGE', 'Evaluations can only be submitted during investigation')

    const problems = []
    const missingChecks = INVESTIGATION_CHECKLIST.filter((i) => !evaluation.checklist?.[i.key])
    if (missingChecks.length) problems.push({ field: 'checklist', message: `Complete: ${missingChecks.map((m) => m.label).join(', ')}` })
    if (!evaluation.findings || evaluation.findings.length < 20) problems.push({ field: 'findings', message: 'Findings must be at least 20 characters' })
    if (evaluation.loss_value == null) problems.push({ field: 'lossValue', message: 'Loss value is required' })
    if (!evaluation.decision) problems.push({ field: 'decision', message: 'A payment decision is required' })

    const policy = await policyForClaim(t, claim)
    const recommended = Number(evaluation.recommended_settlement || 0)
    if (evaluation.decision && evaluation.decision !== 'DENY') {
      if (recommended <= 0) problems.push({ field: 'recommendedSettlement', message: 'Recommended settlement must be greater than zero' })
      if (policy && recommended > Number(policy.sum_insured)) {
        problems.push({ field: 'recommendedSettlement', message: `Recommended settlement exceeds the sum insured (${policy.sum_insured})` })
      }
      if (!reserveAmount) problems.push({ field: 'reserveAmount', message: 'A reserve amount is required' })
      else if (roundMoney(reserveAmount) < recommended) {
        problems.push({ field: 'reserveAmount', message: 'Reserve must cover the recommended settlement' })
      }
    }
    if (problems.length) throw validationError('The evaluation is incomplete', problems)

    const submitted = await t.updateById('evaluations', id, { status: 'SUBMITTED', submitted_at: new Date() })
    await recordAudit(t, ctx.actor, { action: 'EVALUATION_SUBMITTED', entityType: 'evaluation', entityId: id, claimId: claim.id, before: evaluation, after: submitted })
    await t.update('tasks', { claim_id: claim.id, type: 'INVESTIGATION', status: { in: ['OPEN', 'IN_PROGRESS'] } }, {
      status: 'DONE',
      completed_at: new Date(),
      completed_by: ctx.actor.id,
    })

    if (submitted.decision === 'DENY') {
      // Denials always go to an Claims Manager (reverse-review checkpoint); the adjuster cannot deny.
      await notify(ctx, t, {
        recipientIds: (await userIdsWithRole(t, ROLES.OPS_MANAGER)).filter((m) => m !== ctx.actor.id),
        claimId: claim.id,
        type: 'APPROVAL_REQUIRED',
        title: `Denial recommended: ${claim.claim_number}`,
        message: `Adjuster ${ctx.actor.fullName} recommends denying claim ${claim.claim_number}. A manager decision is required.`,
        link: claimLink(claim, false),
      })
      return { evaluation: submitted, reserve: null, claim }
    }

    const { reserve, withinAuthority } = await setReserve(ctx, t, claim, {
      evaluationId: id,
      coverageLine,
      amount: reserveAmount,
      reasonCode: 'INITIAL',
      notes: reserveReason || `Reserve for evaluation v${submitted.version_no}`,
    })
    const updatedClaim = withinAuthority
      ? await transitionClaim(ctx, t, claim, 'COMPLIANCE_REVIEW', { reason: `Evaluation v${submitted.version_no} submitted; reserve posted within authority` })
      : await transitionClaim(ctx, t, claim, 'RESERVE_APPROVAL', { reason: `Evaluation v${submitted.version_no} submitted; reserve above adjuster authority` })
    return { evaluation: submitted, reserve, claim: updatedClaim }
  })
}

/** Manager returns a submitted evaluation (and any pending reserve) for correction. */
export async function returnEvaluation(ctx, id, { comment }) {
  return ctx.db.tx(async (t) => {
    requirePermission(ctx.actor, 'evaluations.return')
    const evaluation = await t.findOne('evaluations', { id }, { forUpdate: true })
    if (!evaluation) throw notFound('Evaluation not found')
    await loadAccessibleClaim(t, ctx.actor, evaluation.claim_id)
    const claim = await lockClaim(t, evaluation.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'APPROVED'].includes(evaluation.status)) {
      throw businessRule('EVALUATION_NOT_SUBMITTED', 'Only submitted or approved evaluations can be returned')
    }
    if (evaluation.adjuster_id === ctx.actor.id) throw forbidden('You cannot review your own evaluation', 'SELF_APPROVAL_FORBIDDEN')

    const now = new Date()
    const returned = await t.updateById('evaluations', id, {
      status: 'RETURNED',
      reviewed_by: ctx.actor.id,
      reviewed_at: now,
      review_comment: comment,
    })
    await t.insert('reviews', {
      claim_id: claim.id,
      checkpoint_type: 'EVALUATION',
      subject_type: 'evaluation',
      subject_id: id,
      status: 'DECIDED',
      outcome: 'RETURNED',
      requested_by: evaluation.adjuster_id,
      reviewer_id: ctx.actor.id,
      decided_by: ctx.actor.id,
      comments: comment,
      reviewed_at: now,
    })
    await recordAudit(t, ctx.actor, { action: 'EVALUATION_RETURNED', entityType: 'evaluation', entityId: id, claimId: claim.id, before: evaluation, after: returned, metadata: { comments: comment } })

    const pending = await t.findMany('reserves', { where: { claim_id: claim.id, approval_status: 'PENDING_REVIEW' } })
    for (const r of pending) await t.updateById('reserves', r.id, { approval_status: 'RETURNED', review_comment: comment, updated_by: ctx.actor.id })

    let updatedClaim = claim
    if (['RESERVE_APPROVAL', 'SETTLEMENT_APPROVAL', 'COMPLIANCE_REVIEW'].includes(claim.status)) {
      updatedClaim = await transitionClaim(ctx, t, claim, 'INVESTIGATION', { reason: `Evaluation returned for correction: ${comment}` })
    }
    await t.insert('tasks', {
      claim_id: claim.id,
      title: `Correct evaluation for ${claim.claim_number}`,
      description: comment,
      type: 'INVESTIGATION',
      owner_user_id: evaluation.adjuster_id,
      owner_role: ROLES.ADJUSTER,
      claimed_at: now,
      source_stage: updatedClaim.stage,
      priority: claim.priority,
      blocking: true,
      created_by: ctx.actor.id,
    })
    await notify(ctx, t, {
      recipientIds: [evaluation.adjuster_id],
      claimId: claim.id,
      type: 'APPROVAL_DECISION',
      title: `Evaluation returned: ${claim.claim_number}`,
      message: comment,
      link: `/claims/${claim.id}?tab=investigation`,
    })
    return { evaluation: returned, claim: updatedClaim }
  })
}
