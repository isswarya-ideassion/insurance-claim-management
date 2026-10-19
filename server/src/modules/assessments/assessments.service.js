import { ROLES, INVESTIGATION_CHECKLIST } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { roundMoney } from '../../utils/format.js'

const FIELD_MAP = {
  checklist: 'checklist',
  findings: 'findings',
  evidence: 'evidence',
  estimatedLoss: 'estimated_loss',
  recommendedSettlement: 'recommended_settlement',
  recommendation: 'recommendation',
  internalNotes: 'internal_notes',
}

function mapFields(input) {
  const out = {}
  for (const [k, col] of Object.entries(FIELD_MAP)) if (input[k] !== undefined) out[col] = input[k]
  return out
}

export async function listAssessments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireTab(ctx.actor, claim, 'investigation')
  const rows = await ctx.db.findMany('assessments', { where: { claim_id: claimId }, orderBy: [['version_no', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.adjuster_id, r.reviewed_by]))
  return rows.map((r) => ({ ...r, adjuster_name: nameOf(names, r.adjuster_id), reviewed_by_name: nameOf(names, r.reviewed_by) }))
}

function requireAssignedAdjuster(ctx, claim) {
  requirePermission(ctx.actor, 'assessments.write')
  requireNotOwnClaim(ctx.actor, claim)
  if (claim.assigned_adjuster_id !== ctx.actor.id) throw forbidden('Only the assigned adjuster can work on this assessment')
}

export async function createAssessment(ctx, claimId, input) {
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireAssignedAdjuster(ctx, claim)
    if (claim.status !== 'INVESTIGATION') throw businessRule('INVALID_STAGE', 'Assessments can only be started during investigation')

    const latest = await t.findOne('assessments', { claim_id: claimId }, { orderBy: [['version_no', 'desc']], forUpdate: true })
    if (latest && ['DRAFT', 'SUBMITTED'].includes(latest.status)) {
      throw businessRule('ASSESSMENT_IN_PROGRESS', `Version ${latest.version_no} is already ${latest.status.toLowerCase()}`, { assessmentId: latest.id })
    }
    const carry = latest
      ? {
          checklist: latest.checklist,
          findings: latest.findings,
          evidence: latest.evidence,
          estimated_loss: latest.estimated_loss,
          recommended_settlement: latest.recommended_settlement,
          recommendation: latest.recommendation,
          internal_notes: latest.internal_notes,
        }
      : { estimated_loss: claim.estimated_loss }
    const assessment = await t.insert('assessments', {
      claim_id: claimId,
      version_no: (latest?.version_no || 0) + 1,
      adjuster_id: ctx.actor.id,
      status: 'DRAFT',
      ...carry,
      ...mapFields(input),
    })
    if (latest && latest.status === 'APPROVED') await t.updateById('assessments', latest.id, { status: 'SUPERSEDED' })
    await recordAudit(t, ctx.actor, { action: 'ASSESSMENT_CREATED', entityType: 'assessment', entityId: assessment.id, claimId, after: assessment })
    return assessment
  })
}

export async function updateAssessment(ctx, id, input) {
  return ctx.db.tx(async (t) => {
    const assessment = await t.findOne('assessments', { id }, { forUpdate: true })
    if (!assessment) throw notFound('Assessment not found')
    const claim = await loadAccessibleClaim(t, ctx.actor, assessment.claim_id)
    requireAssignedAdjuster(ctx, claim)
    if (assessment.status !== 'DRAFT') throw businessRule('ASSESSMENT_LOCKED', 'Only draft assessments can be edited')
    const updated = await t.updateById('assessments', id, mapFields(input))
    await recordAudit(t, ctx.actor, { action: 'ASSESSMENT_UPDATED', entityType: 'assessment', entityId: id, claimId: claim.id, before: assessment, after: updated })
    return updated
  })
}

export async function submitAssessment(ctx, id, { reserveAmount, reserveReason }) {
  return ctx.db.tx(async (t) => {
    const assessment = await t.findOne('assessments', { id }, { forUpdate: true })
    if (!assessment) throw notFound('Assessment not found')
    await loadAccessibleClaim(t, ctx.actor, assessment.claim_id)
    const claim = await lockClaim(t, assessment.claim_id)
    requireAssignedAdjuster(ctx, claim)
    if (assessment.status !== 'DRAFT') throw businessRule('ASSESSMENT_LOCKED', 'This assessment has already been submitted')
    if (claim.status !== 'INVESTIGATION') throw businessRule('INVALID_STAGE', 'Assessments can only be submitted during investigation')

    const problems = []
    const missingChecks = INVESTIGATION_CHECKLIST.filter((i) => !assessment.checklist?.[i.key])
    if (missingChecks.length) problems.push({ field: 'checklist', message: `Complete: ${missingChecks.map((m) => m.label).join(', ')}` })
    if (!assessment.findings || assessment.findings.length < 20) problems.push({ field: 'findings', message: 'Findings must be at least 20 characters' })
    if (assessment.estimated_loss == null) problems.push({ field: 'estimatedLoss', message: 'Estimated loss is required' })
    if (!assessment.recommendation) problems.push({ field: 'recommendation', message: 'Settlement recommendation is required' })

    const policy = await t.findById('policies', claim.policy_id)
    const recommended = Number(assessment.recommended_settlement || 0)
    if (assessment.recommendation && assessment.recommendation !== 'DENY') {
      if (recommended <= 0) problems.push({ field: 'recommendedSettlement', message: 'Recommended settlement must be greater than zero' })
      if (policy && recommended > Number(policy.sum_insured)) {
        problems.push({ field: 'recommendedSettlement', message: `Recommended settlement exceeds the sum insured (${policy.sum_insured})` })
      }
      if (!reserveAmount) problems.push({ field: 'reserveAmount', message: 'A reserve amount is required' })
      else if (roundMoney(reserveAmount) < recommended) {
        problems.push({ field: 'reserveAmount', message: 'Reserve must cover the recommended settlement' })
      }
    }
    if (problems.length) throw validationError('The assessment is incomplete', problems)

    const submitted = await t.updateById('assessments', id, { status: 'SUBMITTED', submitted_at: new Date() })
    await recordAudit(t, ctx.actor, { action: 'ASSESSMENT_SUBMITTED', entityType: 'assessment', entityId: id, claimId: claim.id, before: assessment, after: submitted })
    await t.update('tasks', { claim_id: claim.id, task_type: 'INVESTIGATION', status: { in: ['OPEN', 'IN_PROGRESS'] } }, {
      status: 'DONE',
      completed_at: new Date(),
      completed_by: ctx.actor.id,
    })

    const managers = (await userIdsWithRole(t, ROLES.CLAIMS_MANAGER)).filter((m) => m !== ctx.actor.id)
    if (submitted.recommendation === 'DENY') {
      await notify(ctx, t, {
        recipientIds: managers,
        claimId: claim.id,
        type: 'APPROVAL_REQUIRED',
        title: `Denial recommended: ${claim.claim_number}`,
        message: `Adjuster ${ctx.actor.fullName} recommends denying claim ${claim.claim_number}. A manager decision is required.`,
        link: claimLink(claim, false),
      })
      return { assessment: submitted, reserve: null, claim }
    }

    await t.update('reserves', { claim_id: claim.id, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, { status: 'SUPERSEDED' })
    const reserve = await t.insert('reserves', {
      claim_id: claim.id,
      assessment_id: id,
      amount: roundMoney(reserveAmount),
      reason: reserveReason || `Reserve for assessment v${submitted.version_no}`,
      requested_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'RESERVE_REQUESTED', entityType: 'reserve', entityId: reserve.id, claimId: claim.id, after: reserve })
    const updatedClaim = await transitionClaim(ctx, t, claim, 'RESERVE_APPROVAL', { reason: `Assessment v${submitted.version_no} submitted` })
    await notify(ctx, t, {
      recipientIds: managers,
      claimId: claim.id,
      type: 'APPROVAL_REQUIRED',
      title: `Reserve approval required: ${claim.claim_number}`,
      message: `Reserve of ${reserve.amount.toFixed(2)} requested by ${ctx.actor.fullName}.`,
      link: `/claims/${claim.id}?tab=reserves`,
    })
    return { assessment: submitted, reserve, claim: updatedClaim }
  })
}

/** Manager returns a submitted assessment (and any pending reserve) for correction. */
export async function returnAssessment(ctx, id, { comment }, t = null) {
  const run = async (tx) => {
    requirePermission(ctx.actor, 'assessments.return')
    const assessment = await tx.findOne('assessments', { id }, { forUpdate: true })
    if (!assessment) throw notFound('Assessment not found')
    await loadAccessibleClaim(tx, ctx.actor, assessment.claim_id)
    const claim = await lockClaim(tx, assessment.claim_id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'APPROVED'].includes(assessment.status)) {
      throw businessRule('ASSESSMENT_NOT_SUBMITTED', 'Only submitted or approved assessments can be returned')
    }
    if (assessment.adjuster_id === ctx.actor.id) throw forbidden('You cannot review your own assessment', 'SELF_APPROVAL_FORBIDDEN')

    const returned = await tx.updateById('assessments', id, {
      status: 'RETURNED',
      reviewed_by: ctx.actor.id,
      reviewed_at: new Date(),
      review_comment: comment,
    })
    await recordAudit(tx, ctx.actor, { action: 'ASSESSMENT_RETURNED', entityType: 'assessment', entityId: id, claimId: claim.id, before: assessment, after: returned, metadata: { comments: comment } })

    const pending = await tx.findOne('reserves', { claim_id: claim.id, status: 'PENDING_APPROVAL' }, { forUpdate: true })
    if (pending) {
      await tx.insert('approvals', {
        claim_id: claim.id,
        approval_type: 'RESERVE',
        reserve_id: pending.id,
        amount: pending.amount,
        decision: 'RETURNED',
        requested_by: pending.requested_by,
        decided_by: ctx.actor.id,
        comments: comment,
      })
      await tx.updateById('reserves', pending.id, { status: 'RETURNED', decided_at: new Date() })
    }

    let updatedClaim = claim
    if (['RESERVE_APPROVAL', 'SETTLEMENT_APPROVAL', 'COMPLIANCE_REVIEW'].includes(claim.status)) {
      updatedClaim = await transitionClaim(ctx, tx, claim, 'INVESTIGATION', { reason: `Assessment returned for correction: ${comment}` })
    }
    await tx.insert('tasks', {
      claim_id: claim.id,
      title: `Correct assessment for ${claim.claim_number}`,
      description: comment,
      task_type: 'INVESTIGATION',
      assignee_id: assessment.adjuster_id,
      assigned_role: ROLES.CLAIMS_ADJUSTER,
      priority: claim.priority,
      is_mandatory: true,
      created_by: ctx.actor.id,
    })
    await notify(ctx, tx, {
      recipientIds: [assessment.adjuster_id],
      claimId: claim.id,
      type: 'APPROVAL_DECISION',
      title: `Assessment returned: ${claim.claim_number}`,
      message: comment,
      link: `/claims/${claim.id}?tab=investigation`,
    })
    return { assessment: returned, claim: updatedClaim }
  }
  return t ? run(t) : ctx.db.tx(run)
}
