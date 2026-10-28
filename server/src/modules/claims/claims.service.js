import { createHash } from 'node:crypto'
import {
  ROLES,
  ACTIVE_STATUSES,
  INTAKE_CHECKLIST,
  OPEN_TASK_STATUSES,
  STATUS_LABELS,
  STAGE_LABELS,
  CUSTOMER_STATUS_LABELS,
  PRIVACY_NOTICE_VERSION,
  humanize,
} from '../../../../shared/constants.js'
import { can, canSeeTab, visibleTabs, permissionsFor } from '../../../../shared/permissions.js'
import { businessRule, conflict, forbidden, notFound, validationError } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import {
  claimScope,
  loadAccessibleClaim,
  isCustomerView,
  isStaff,
  requirePermission,
  requireNotOwnClaim,
  requireStaffView,
} from '../../services/access.service.js'
import { availableTransitions, lockClaim, missingRequiredDocuments, transitionClaim, hasActiveComplianceHold } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { checkClaimEligibility, evaluatePolicyEligibility, policyForClaim } from '../../services/eligibility.service.js'
import { requiredArtifacts, severityFor } from '../../services/config.service.js'
import { claimClocks, recordAcknowledgement } from '../../services/sla.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { claimantContacts, presentClaimForCustomer, presentClaimForStaff, presentClaims, profileMap, nameOf } from '../../services/presenters.js'
import { presentPolicy, presentPolicyWithPayee } from '../policies/policies.service.js'
import { submissionReadySchema } from './claims.validators.js'

const DRAFT_FIELD_MAP = {
  claimType: 'claim_type',
  insuredName: 'insured_name',
  lossDate: 'loss_date',
  lossLocation: 'loss_location',
  lossCity: 'loss_city',
  lossCountry: 'loss_country',
  lossType: 'loss_type',
  lossDescription: 'loss_description',
  estimatedLoss: 'estimated_loss',
  affectedAsset: 'affected_asset',
  declarationAccepted: 'declaration_accepted',
  draftStep: 'draft_step',
}
const CONTACT_FIELDS = ['contactName', 'contactPhone', 'contactEmail']

async function resolvePolicyForDraft(t, actor, policyNumber) {
  if (policyNumber === undefined) return undefined
  if (!policyNumber) return { policy_id: null }
  const policy = await t.findOne('policies', { external_policy_no: policyNumber.toUpperCase() })
  const staffOnBehalf = can(actor.roles, 'claims.create') && !actor.roles.includes(ROLES.CLIENT)
  if (!policy || (!staffOnBehalf && policy.insured_id !== actor.id)) {
    throw validationError('Policy not found for your account', [{ field: 'policyNumber', message: 'Policy not found for your account' }])
  }
  return { policy_id: policy.id, policy }
}

function mapDraftInput(input, actor) {
  const out = {}
  for (const [key, column] of Object.entries(DRAFT_FIELD_MAP)) {
    if (input[key] !== undefined) out[column] = input[key]
  }
  // Customers cannot change the insured name: it is taken from the policy.
  if (actor.roles.includes(ROLES.CLIENT)) delete out.insured_name
  if (input.declarationAccepted === true) out.declaration_accepted_at = new Date()
  if (input.declarationAccepted === false) out.declaration_accepted_at = null
  return out
}

/** Stores claimant contact details on the CLAIMANT party, encrypted at rest. */
async function saveClaimant(ctx, t, claimId, input) {
  if (!CONTACT_FIELDS.some((k) => input[k] !== undefined)) return
  const existing = await t.findOne('claim_parties', { claim_id: claimId, party_type: 'CLAIMANT' })
  const contact = existing?.contact_encrypted ? ctx.crypto.decryptJson(existing.contact_encrypted) : {}
  if (input.contactPhone !== undefined) contact.phone = input.contactPhone || null
  if (input.contactEmail !== undefined) contact.email = input.contactEmail || null
  const values = {
    name: input.contactName !== undefined ? input.contactName || null : existing?.name ?? null,
    contact_encrypted: ctx.crypto.encryptJson(contact),
  }
  if (existing) await t.updateById('claim_parties', existing.id, values)
  else {
    await t.insert('claim_parties', {
      claim_id: claimId,
      party_type: 'CLAIMANT',
      role_in_loss: 'Claimant',
      is_payee_candidate: true,
      created_by: ctx.actor.id,
      ...values,
    })
  }
}

async function contactFor(ctx, t, claimId) {
  return (await claimantContacts(t, ctx.crypto, [claimId]))[claimId] || null
}

function assertVersion(claim, version) {
  if (version !== undefined && version !== null && Number(version) !== Number(claim.version)) {
    throw conflict('This claim was changed by someone else. Reload it and try again.', 'VERSION_CONFLICT', {
      expected: version,
      current: claim.version,
    })
  }
}

// ---------------------------------------------------------------------------
// Drafts and submission
// ---------------------------------------------------------------------------
export async function createDraft(ctx, input) {
  requirePermission(ctx.actor, 'claims.create')
  return ctx.db.tx(async (t) => {
    const resolved = await resolvePolicyForDraft(t, ctx.actor, input.policyNumber)
    const client = ctx.actor.roles.includes(ROLES.CLIENT)
    if (!client && !resolved?.policy) {
      throw validationError('Staff must provide the policy number when creating a claim on behalf of a client')
    }
    const customerId = resolved?.policy && !client ? resolved.policy.insured_id : ctx.actor.id
    const claim = await t.insert('claims', {
      ...mapDraftInput(input, ctx.actor),
      policy_id: resolved?.policy_id ?? null,
      claim_type: input.claimType ?? resolved?.policy?.policy_type ?? null,
      insured_name: (client ? null : input.insuredName) ?? resolved?.policy?.insured_name ?? null,
      segment: resolved?.policy?.segment ?? 'PERSONAL',
      customer_id: customerId,
      created_by: ctx.actor.id,
      status: 'DRAFT',
    })
    await saveClaimant(ctx, t, claim.id, input)
    await recordAudit(t, ctx.actor, { action: 'CLAIM_DRAFT_CREATED', entityType: 'claim', entityId: claim.id, claimId: claim.id, after: claim })
    return { ...claim, ...(await contactFor(ctx, t, claim.id)) }
  })
}

export async function updateClaim(ctx, id, input, kind) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    assertVersion(claim, input.version)
    let patch
    if (kind === 'draft') {
      if (claim.status !== 'DRAFT') throw businessRule('CLAIM_NOT_EDITABLE', 'Only draft claims can be edited')
      if (claim.customer_id !== ctx.actor.id && claim.created_by !== ctx.actor.id) throw forbidden('You can only edit your own drafts')
      const resolved = await resolvePolicyForDraft(t, ctx.actor, input.policyNumber)
      patch = { ...mapDraftInput(input, ctx.actor) }
      const client = ctx.actor.roles.includes(ROLES.CLIENT)
      if (resolved) {
        patch.policy_id = resolved.policy_id
        if (resolved.policy) {
          patch.claim_type = input.claimType ?? resolved.policy.policy_type
          patch.insured_name = client ? resolved.policy.insured_name : input.insuredName ?? claim.insured_name ?? resolved.policy.insured_name
          patch.segment = resolved.policy.segment
        }
      }
      await saveClaimant(ctx, t, id, input)
    } else {
      requirePermission(ctx.actor, 'claims.updateMeta')
      requireNotOwnClaim(ctx.actor, claim)
      patch = {}
      if (input.priority) patch.priority = input.priority
      if (input.dueDate !== undefined) patch.due_date = input.dueDate
      if (input.complexity !== undefined) patch.complexity = input.complexity
    }
    patch.updated_by = ctx.actor.id
    const updated = await t.updateById('claims', id, patch)
    await recordAudit(t, ctx.actor, {
      action: kind === 'draft' ? 'CLAIM_DRAFT_UPDATED' : 'CLAIM_UPDATED',
      entityType: 'claim',
      entityId: id,
      claimId: id,
      before: claim,
      after: updated,
    })
    return { ...updated, ...(await contactFor(ctx, t, id)) }
  })
}

function autoPriority(estimatedLoss) {
  const amount = Number(estimatedLoss || 0)
  if (amount >= 200_000) return 'URGENT'
  if (amount >= 50_000) return 'HIGH'
  if (amount >= 5_000) return 'MEDIUM'
  return 'LOW'
}

/** Freezes the policy as it stands at FNOL; coverage checks read this snapshot, never the live policy. */
async function capturePolicySnapshot(ctx, t, claim, reason) {
  const policy = await t.findById('policies', claim.policy_id)
  const { payee_id: _payee, ...snapshot } = policy
  return t.insert('policy_snapshots', {
    claim_id: claim.id,
    policy_id: policy.id,
    policy_version: policy.version,
    snapshot,
    sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    reason,
    captured_by: ctx.actor.id,
  })
}

/** One tracked requirement per required artifact; documents uploaded with the draft count as received. */
async function createRequiredArtifacts(t, claim) {
  const required = await requiredArtifacts(t, claim.segment, claim.claim_type)
  for (const docType of required) {
    const doc = await t.findOne('documents', { claim_id: claim.id, doc_type: docType }, { orderBy: [['received_at', 'desc']] })
    await t.query(
      `insert into public.artifact_requirements (claim_id, requirement_type, doc_type, is_required, status, document_id)
       values ($1, 'DOCUMENT', $2, true, $3, $4) on conflict (claim_id, doc_type) where is_required do nothing`,
      [claim.id, docType, doc ? 'RECEIVED' : 'MISSING', doc?.id || null],
    )
  }
}

export async function submitClaim(ctx, id, { submissionKey, confirmSeparateClaim }) {
  return ctx.db.tx(async (t) => {
    if (submissionKey) {
      const replay = await t.findOne('claims', { submission_key: submissionKey })
      if (replay) {
        if (replay.customer_id !== ctx.actor.id && replay.created_by !== ctx.actor.id) {
          throw conflict('Submission key already used', 'IDEMPOTENCY_KEY_REUSED')
        }
        return { claim: replay, replayed: true }
      }
    }

    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    if (claim.status !== 'DRAFT') {
      throw businessRule('ALREADY_SUBMITTED', `Claim ${claim.claim_number} has already been submitted`, {
        claimNumber: claim.claim_number,
      })
    }

    const contact = await contactFor(ctx, t, id)
    const ready = submissionReadySchema.safeParse({ ...claim, ...(contact || {}) })
    if (!ready.success) {
      throw validationError(
        'The claim is incomplete',
        ready.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      )
    }

    const eligibility = await checkClaimEligibility(t, claim)
    if (!eligibility.eligible) {
      throw businessRule('POLICY_NOT_ELIGIBLE', `Policy is not eligible for this claim: ${eligibility.reasons.join('; ')}`, {
        reasons: eligibility.reasons,
      })
    }

    // Accidental duplicate detection: same policy, loss type and loss date within 24 hours.
    const loss = new Date(claim.loss_date)
    const duplicates = await t.findMany('claims', {
      where: {
        id: { ne: claim.id },
        policy_id: claim.policy_id,
        loss_type: claim.loss_type,
        status: { nin: ['DRAFT', 'WITHDRAWN'] },
        loss_date: { gte: new Date(loss.getTime() - 86_400_000), lte: new Date(loss.getTime() + 86_400_000) },
      },
      columns: ['id', 'claim_number', 'status', 'loss_date', 'estimated_loss'],
      limit: 5,
    })
    if (duplicates.length && !confirmSeparateClaim) {
      throw conflict(
        'A claim for a similar loss on this policy already exists. Confirm that this is a separate incident to continue.',
        'POSSIBLE_DUPLICATE',
        { existing: duplicates.map((d) => ({ ...d, status_label: CUSTOMER_STATUS_LABELS[d.status] })) },
      )
    }

    const snapshot = await capturePolicySnapshot(ctx, t, claim, 'FNOL')
    const [{ claim_number: claimNumber }] = await t.query('select public.next_claim_number() as claim_number')
    const now = new Date()
    const submitted = await transitionClaim(ctx, t, claim, 'SUBMITTED', {
      patch: {
        claim_number: claimNumber,
        opened_at: now,
        submission_key: submissionKey || null,
        possible_duplicate_of: duplicates[0]?.id || null,
        priority: autoPriority(claim.estimated_loss),
        severity: await severityFor(t, claim.segment, claim.estimated_loss),
        policy_snapshot_id: snapshot.id,
      },
    })
    await createRequiredArtifacts(t, submitted)
    await t.insert('consents', {
      subject_id: submitted.customer_id,
      claim_id: submitted.id,
      consent_type: 'CLAIM_DECLARATION',
      notice_version: PRIVACY_NOTICE_VERSION,
      granted: true,
    })
    // The submission notification sent by the workflow is the client acknowledgement.
    await recordAcknowledgement(t, submitted, now)

    if (duplicates.length) {
      // The claim's Claims Operations Manager checks the duplicate during intake.
      const owner = (await t.findById('claims', submitted.id)).assigned_owner_id
      await notify(ctx, t, {
        recipientIds: owner ? [owner] : await userIdsWithRole(t, ROLES.CLAIMS_OPS_MANAGER),
        claimId: submitted.id,
        type: 'CLAIM_SUBMITTED',
        title: `Possible duplicate: ${submitted.claim_number}`,
        message: `The client confirmed ${submitted.claim_number} is separate from ${duplicates[0].claim_number}. Please verify during intake.`,
        link: claimLink(submitted, false),
        email: false,
      })
    }
    return { claim: submitted, replayed: false }
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function buildListFilter(ctx, query) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden('Your role cannot view claims')
  const filters = [scope]
  const customerOnly = !isStaff(ctx.actor)

  if (query.status?.length) filters.push({ status: { in: query.status } })
  else if (!customerOnly) filters.push({ status: { ne: 'DRAFT' } })
  if (customerOnly) filters.push({ $or: [{ claim_number: { ne: null } }, { status: 'DRAFT' }] })
  if (query.claimType?.length) filters.push({ claim_type: { in: query.claimType } })
  if (query.priority?.length) filters.push({ priority: { in: query.priority } })
  if (query.stage?.length) filters.push({ stage: { in: query.stage } })
  if (query.segment) filters.push({ segment: query.segment })
  if (query.from) filters.push({ opened_at: { gte: query.from } })
  if (query.to) filters.push({ opened_at: { lte: new Date(new Date(query.to).getTime() + 86_399_999) } })
  if (query.overdue === 'true') filters.push({ due_date: { lt: new Date() }, status: { in: ACTIVE_STATUSES } })
  if (query.escalated === 'true') filters.push({ escalation_level: { gt: 0 } })
  if (query.needsAdjuster === 'true') filters.push({ status: 'ADJUSTER_ASSIGNMENT', assigned_adjuster_id: null })

  if (query.assigneeId === 'unassigned') {
    filters.push({ assigned_owner_id: null, status: { in: ACTIVE_STATUSES } })
  } else if (query.assigneeId) {
    const id = query.assigneeId === 'me' ? ctx.actor.id : query.assigneeId
    filters.push({ $or: [{ assigned_owner_id: id }, { assigned_adjuster_id: id }, { assigned_reviewer_id: id }] })
  }

  if (query.search) {
    const term = `%${escapeLike(query.search)}%`
    const [policies, customers, parties] = await Promise.all([
      ctx.db.findMany('policies', { where: { external_policy_no: { ilike: term } }, columns: ['id'], limit: 200 }),
      ctx.db.findMany('users', { where: { full_name: { ilike: term } }, columns: ['id'], limit: 200 }),
      ctx.db.findMany('claim_parties', { where: { name: { ilike: term } }, columns: ['claim_id'], limit: 200 }),
    ])
    filters.push({
      $or: [
        { claim_number: { ilike: term } },
        { insured_name: { ilike: term } },
        { id: { in: parties.map((p) => p.claim_id) } },
        { policy_id: { in: policies.map((p) => p.id) } },
        { customer_id: { in: customers.map((c) => c.id) } },
      ],
    })
  }
  return { $and: filters }
}

export async function listClaims(ctx, query) {
  const where = await buildListFilter(ctx, query)
  const orderBy = [[query.sort, query.order], ['created_at', 'desc']]
  const [rows, total] = await Promise.all([
    ctx.db.findMany('claims', { where, orderBy, ...toOffset(query) }),
    ctx.db.count('claims', where),
  ])
  const policyIds = rows.map((r) => r.policy_id).filter(Boolean)
  const policies = policyIds.length
    ? await ctx.db.findMany('policies', { where: { id: { in: policyIds } }, columns: ['id', 'external_policy_no'] })
    : []
  const policyNumbers = Object.fromEntries(policies.map((p) => [p.id, p.external_policy_no]))
  const items = (await presentClaims(ctx.db, rows, ctx.actor)).map((c) => ({
    ...c,
    policy_number: policyNumbers[c.policy_id] || null,
  }))
  return { items, meta: pageMeta(query, total) }
}

export async function claimStats(ctx) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) throw forbidden('Your role cannot view claims')
  const where = { $and: [scope, { status: { ne: 'DRAFT' } }] }
  const byStatus = await ctx.db.groupCount('claims', 'status', where)
  const byStage = await ctx.db.groupCount('claims', 'stage', { $and: [where, { status: { in: [...ACTIVE_STATUSES, 'ON_HOLD'] } }] })
  const sum = (...statuses) => statuses.reduce((acc, s) => acc + (byStatus[s] || 0), 0)
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)

  const scopedIds = (await ctx.db.findMany('claims', { where, columns: ['id'] })).map((r) => r.id)
  const overdueTasks = await ctx.db.count('tasks', {
    status: { in: OPEN_TASK_STATUSES },
    due_at: { lt: new Date() },
    $or: [{ claim_id: { in: scopedIds } }, { owner_user_id: ctx.actor.id }],
  })
  const myOpenTasks = await ctx.db.count('tasks', { status: { in: OPEN_TASK_STATUSES }, owner_user_id: ctx.actor.id })
  const escalated = await ctx.db.count('claims', { $and: [where, { escalation_level: { gt: 0 } }, { status: { in: ACTIVE_STATUSES } }] })
  const overdueClaims = await ctx.db.count('claims', {
    $and: [where, { due_date: { lt: new Date() } }, { status: { in: ACTIVE_STATUSES } }],
  })
  const slaBreached = scopedIds.length
    ? (await ctx.db.query(
        `select count(*)::int as count from public.sla_clocks
          where claim_id = any($1) and stopped_at is null and breached_at is not null`,
        [scopedIds],
      ))[0].count
    : 0

  return {
    total,
    newlySubmitted: sum('SUBMITTED'),
    awaitingVerification: sum('POLICY_VERIFICATION'),
    awaitingDocuments: sum('DOCUMENTS_REQUIRED'),
    inDocumentReview: sum('DOCUMENT_REVIEW'),
    awaitingAdjuster: sum('ADJUSTER_ASSIGNMENT'),
    underInvestigation: sum('INVESTIGATION'),
    awaitingApproval: sum('RESERVE_APPROVAL', 'SETTLEMENT_APPROVAL'),
    inCompliance: sum('COMPLIANCE_REVIEW'),
    awaitingPayment: sum('PAYMENT_PENDING', 'PAYMENT_FAILED'),
    paid: sum('PAID'),
    closed: sum('CLOSED'),
    rejected: sum('REJECTED'),
    onHold: sum('ON_HOLD'),
    overdueTasks,
    overdueClaims,
    slaBreached,
    escalated,
    myOpenTasks,
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, label: STATUS_LABELS[status], count })),
    byStage: Object.entries(byStage).map(([stage, count]) => ({ stage, label: STAGE_LABELS[stage], count })),
  }
}

export async function getClaimDetail(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const policy = await policyForClaim(ctx.db, claim)
  const livePolicy = claim.policy_id ? await ctx.db.findById('policies', claim.policy_id) : null

  if (isCustomerView(ctx.actor, claim)) {
    const requirements = await ctx.db.findMany('artifact_requirements', { where: { claim_id: id, is_required: true } })
    const required = requirements.length ? requirements.map((r) => r.doc_type) : await requiredArtifacts(ctx.db, claim.segment, claim.claim_type)
    const openRequests = await ctx.db.count('artifact_requirements', { claim_id: id, status: 'REQUESTED' })
    return {
      claim: presentClaimForCustomer(claim, await contactFor(ctx, ctx.db, id)),
      policy: livePolicy ? await presentPolicyWithPayee(ctx.db, livePolicy) : null,
      requiredDocuments: required,
      openRequests,
      transitions: (await availableTransitions(ctx.db, claim, ctx.actor)).filter((tr) => tr.allowed || tr.to === 'WITHDRAWN'),
    }
  }

  const names = await profileMap(ctx.db, [
    claim.customer_id,
    claim.assigned_owner_id,
    claim.assigned_adjuster_id,
    claim.assigned_reviewer_id,
    claim.document_exception_by,
  ])
  const currentTask = await ctx.db.findOne(
    'tasks',
    { claim_id: id, status: { in: OPEN_TASK_STATUSES } },
    { orderBy: [['blocking', 'desc'], ['due_at', 'asc']] },
  )
  const [missingDocs, eligibility, coverage, clocks, closureRequest] = await Promise.all([
    missingRequiredDocuments(ctx.db, claim),
    policy ? checkClaimEligibility(ctx.db, claim) : null,
    ctx.db.findOne('coverage_results', { claim_id: id }, { orderBy: [['created_at', 'desc']] }),
    claimClocks(ctx.db, id),
    ctx.db.findOne('closure_requests', { claim_id: id, status: 'PENDING' }),
  ])
  const [openTasks, openRequests, pendingDocs] = await Promise.all([
    ctx.db.count('tasks', { claim_id: id, status: { in: OPEN_TASK_STATUSES } }),
    ctx.db.count('artifact_requirements', { claim_id: id, status: 'REQUESTED' }),
    ctx.db.count('documents', { claim_id: id, status: 'PENDING_REVIEW' }),
  ])
  const duplicateOf = claim.possible_duplicate_of
    ? await ctx.db.findOne('claims', { id: claim.possible_duplicate_of }, { columns: ['id', 'claim_number', 'status'] })
    : null
  // Contact details are personal data: shown to roles that work the claim, not to data engineers or payment operators.
  const contact = canSeeTab(ctx.actor.roles, 'documents') ? await contactFor(ctx, ctx.db, id) : null
  const coverageNames = coverage ? await profileMap(ctx.db, [coverage.reviewed_by]) : {}

  return {
    claim: {
      ...presentClaimForStaff(claim, names, ctx.actor.roles, contact),
      document_exception_by_name: nameOf(names, claim.document_exception_by),
    },
    policy: policy ? { ...presentPolicy(policy), from_snapshot: Boolean(policy.snapshot_id) } : null,
    customer: names[claim.customer_id] || null,
    currentTask,
    eligibility,
    coverage: coverage ? { ...coverage, reviewed_by_name: nameOf(coverageNames, coverage.reviewed_by) } : null,
    slaClocks: clocks,
    closureRequest,
    requiredDocuments: (await ctx.db.findMany('artifact_requirements', { where: { claim_id: id, is_required: true }, columns: ['doc_type'] })).map((r) => r.doc_type),
    missingDocuments: claim.document_exception_at ? [] : missingDocs,
    complianceHold: await hasActiveComplianceHold(ctx.db, id),
    duplicateOf,
    counts: { openTasks, openRequests, pendingDocs },
    intakeChecklist: INTAKE_CHECKLIST.map((item) => ({ ...item, ...(claim.intake_checklist?.[item.key] || { checked: false }) })),
    permissions: {
      tabs: visibleTabs(ctx.actor.roles),
      actions: permissionsFor(ctx.actor.roles),
    },
  }
}

export async function getTransitions(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  return availableTransitions(ctx.db, claim, ctx.actor)
}

export async function changeStatus(ctx, id, { toStatus, reason, customerMessage }) {
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    if (toStatus === 'SUBMITTED' && claim.status === 'DRAFT') {
      throw businessRule('USE_SUBMIT_ENDPOINT', 'Submit claims with POST /claims/:id/submit')
    }
    return transitionClaim(ctx, t, claim, toStatus, { reason, customerMessage })
  })
}

// ---------------------------------------------------------------------------
// Intake operations
// ---------------------------------------------------------------------------

/**
 * Coverage verification (PRD section 3.2). Hard facts are checked against the
 * policy snapshot; a COVERED result is refused when they fail. Every result is
 * recorded in coverage_results and summarised on the claim.
 */
export async function verifyCoverage(ctx, id, { result, notes, clauseRefs, aiRunRef = null }) {
  requirePermission(ctx.actor, 'claims.verifyCoverage')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Coverage verification is only possible during intake')
    }
    const policy = await policyForClaim(t, claim)
    const check = evaluatePolicyEligibility(policy, {
      customerId: claim.customer_id,
      lossDate: claim.loss_date,
      claimType: claim.claim_type,
      lossType: claim.loss_type,
    })
    if (result === 'COVERED' && !check.eligible) {
      throw businessRule('POLICY_NOT_ELIGIBLE', `Coverage cannot be confirmed: ${check.reasons.join('; ')}`, { reasons: check.reasons })
    }
    const coverage = await t.insert('coverage_results', {
      claim_id: id,
      snapshot_id: claim.policy_snapshot_id,
      result,
      matched_perils: result === 'COVERED' && claim.loss_type ? [claim.loss_type] : [],
      applied_limits: policy?.limits || { sum_insured: policy?.sum_insured ?? null },
      deductible: policy?.deductible ?? null,
      clause_refs: clauseRefs || [],
      checks: check.checks,
      notes: notes || (result === 'COVERED' ? 'Verified against the policy snapshot' : check.reasons.join('; ') || null),
      reviewed_by: ctx.actor.id,
      ai_run_ref: aiRunRef,
    })
    const updated = await t.updateById('claims', id, {
      coverage_result: result,
      assigned_owner_id: claim.assigned_owner_id || ctx.actor.id,
      updated_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, {
      action: result === 'COVERED' ? 'COVERAGE_CONFIRMED' : 'COVERAGE_NOT_CONFIRMED',
      entityType: 'coverage_result',
      entityId: coverage.id,
      claimId: id,
      before: claim,
      after: updated,
      metadata: { result, checks: check.checks, reasons: check.reasons },
    })
    return { claim: updated, coverage, eligibility: check }
  })
}

export async function listCoverageResults(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  requireStaffView(ctx.actor, claim)
  const rows = await ctx.db.findMany('coverage_results', { where: { claim_id: id }, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.map((r) => r.reviewed_by))
  return rows.map((r) => ({ ...r, reviewed_by_name: nameOf(names, r.reviewed_by) }))
}

export async function updateIntakeChecklist(ctx, id, { items }) {
  requirePermission(ctx.actor, 'claims.intakeChecklist')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'The intake checklist can only be changed during intake')
    }
    const checklist = { ...(claim.intake_checklist || {}) }
    const now = new Date().toISOString()
    for (const [key, checked] of Object.entries(items)) {
      checklist[key] = checked ? { checked: true, by: ctx.actor.id, by_name: ctx.actor.fullName, at: now } : { checked: false }
    }
    const updated = await t.updateById('claims', id, { intake_checklist: checklist, updated_by: ctx.actor.id })
    await recordAudit(t, ctx.actor, { action: 'INTAKE_CHECKLIST_UPDATED', entityType: 'claim', entityId: id, claimId: id, metadata: { items } })
    return updated
  })
}

export async function escalateClaim(ctx, id, { reason }) {
  requirePermission(ctx.actor, 'claims.escalate')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status) && claim.status !== 'ON_HOLD') {
      throw businessRule('INVALID_STAGE', 'Only open claims can be escalated')
    }
    if (claim.escalation_level >= 3) throw businessRule('MAX_ESCALATION', 'Claim is already at the highest escalation level')
    const updated = await t.updateById('claims', id, {
      escalation_level: claim.escalation_level + 1,
      escalated_at: new Date(),
      escalation_reason: reason,
      priority: ['LOW', 'MEDIUM'].includes(claim.priority) ? 'HIGH' : claim.priority === 'HIGH' ? 'URGENT' : claim.priority,
      updated_by: ctx.actor.id,
    })
    await t.insert('claim_notes', { claim_id: id, author_id: ctx.actor.id, visibility: 'INTERNAL', body: `Escalated to level ${updated.escalation_level}: ${reason}` })
    await recordAudit(t, ctx.actor, { action: 'CLAIM_ESCALATED', entityType: 'claim', entityId: id, claimId: id, before: claim, after: updated })
    await notify(ctx, t, {
      recipientIds: (await userIdsWithRole(t, ROLES.OPS_MANAGER)).filter((u) => u !== ctx.actor.id),
      claimId: id,
      type: 'CLAIM_STATUS_CHANGED',
      title: `Escalation level ${updated.escalation_level}: ${claim.claim_number}`,
      message: reason,
      link: claimLink(claim, false),
    })
    return updated
  })
}

export async function recordDocumentException(ctx, id, { reason }) {
  requirePermission(ctx.actor, 'claims.documentException')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, id)
    const claim = await lockClaim(t, id)
    requireNotOwnClaim(ctx.actor, claim)
    if (!['DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW'].includes(claim.status)) {
      throw businessRule('INVALID_STAGE', 'Document exceptions can only be recorded during document collection or review')
    }
    const missing = await missingRequiredDocuments(t, claim)
    await t.update(
      'artifact_requirements',
      { claim_id: id, is_required: true, status: { nin: ['ACCEPTED', 'WAIVED'] } },
      { status: 'WAIVED', waived_reason: reason, closed_at: new Date() },
    )
    const updated = await t.updateById('claims', id, {
      document_exception_reason: reason,
      document_exception_by: ctx.actor.id,
      document_exception_at: new Date(),
      updated_by: ctx.actor.id,
    })
    await t.insert('claim_notes', {
      claim_id: id,
      author_id: ctx.actor.id,
      visibility: 'INTERNAL',
      body: `Document exception recorded (waived: ${missing.join(', ') || 'none outstanding'}): ${reason}`,
    })
    await recordAudit(t, ctx.actor, {
      action: 'DOCUMENT_EXCEPTION_RECORDED',
      entityType: 'claim',
      entityId: id,
      claimId: id,
      before: claim,
      after: updated,
      metadata: { waived: missing },
    })
    return updated
  })
}

// ---------------------------------------------------------------------------
// Notes and timeline
// ---------------------------------------------------------------------------
export async function listNotes(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const where = { claim_id: id }
  if (isCustomerView(ctx.actor, claim)) where.visibility = 'CUSTOMER'
  const notes = await ctx.db.findMany('claim_notes', { where, orderBy: [['created_at', 'desc']] })
  const names = await profileMap(ctx.db, notes.map((n) => n.author_id))
  return notes.map((n) => ({ ...n, author_name: nameOf(names, n.author_id) }))
}

export async function addNote(ctx, id, { body, visibility }) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id)
    requireStaffView(ctx.actor, claim)
    requirePermission(ctx.actor, visibility === 'CUSTOMER' ? 'claims.notes.customer' : 'claims.notes.internal')
    const note = await t.insert('claim_notes', { claim_id: id, author_id: ctx.actor.id, visibility, body })
    await recordAudit(t, ctx.actor, { action: 'NOTE_ADDED', entityType: 'claim_note', entityId: note.id, claimId: id, metadata: { visibility } })
    if (visibility === 'CUSTOMER') {
      await notify(ctx, t, {
        recipientIds: [claim.customer_id],
        claimId: id,
        type: 'CLAIM_STATUS_CHANGED',
        title: `Update on claim ${claim.claim_number}`,
        message: body.length > 280 ? `${body.slice(0, 277)}...` : body,
        link: claimLink(claim, true),
      })
    }
    return note
  })
}

export async function getTimeline(ctx, id) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, id)
  const customer = isCustomerView(ctx.actor, claim)
  const events = []

  const history = await ctx.db.findMany('claim_status_history', {
    where: customer ? { claim_id: id, customer_visible: true } : { claim_id: id },
    orderBy: [['created_at', 'asc']],
  })
  for (const h of history) {
    events.push({
      id: `status-${h.id}`,
      type: 'STATUS',
      at: h.created_at,
      title: customer ? CUSTOMER_STATUS_LABELS[h.to_status] : `${STATUS_LABELS[h.from_status] || 'New'} → ${STATUS_LABELS[h.to_status]}`,
      description: customer ? h.customer_message : h.reason,
      actorId: customer ? null : h.changed_by,
      status: h.to_status,
    })
  }

  const notes = await ctx.db.findMany('claim_notes', {
    where: customer ? { claim_id: id, visibility: 'CUSTOMER' } : { claim_id: id },
  })
  for (const n of notes) {
    events.push({
      id: `note-${n.id}`,
      type: n.visibility === 'CUSTOMER' ? 'CUSTOMER_NOTE' : 'INTERNAL_NOTE',
      at: n.created_at,
      title: n.visibility === 'CUSTOMER' ? 'Message from claims team' : 'Internal note',
      description: n.body,
      actorId: customer ? null : n.author_id,
    })
  }

  const documentWhere = { claim_id: id }
  if (customer) documentWhere.doc_type = { nin: ['INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE'] }
  const documents = await ctx.db.findMany('documents', { where: documentWhere })
  for (const d of documents) {
    events.push({ id: `doc-up-${d.id}`, type: 'DOCUMENT', at: d.received_at, title: `Document received: ${d.file_name}`, description: humanize(d.doc_type), actorId: customer ? null : d.uploaded_by })
    if (d.reviewed_at) {
      events.push({
        id: `doc-rv-${d.id}`,
        type: 'DOCUMENT',
        at: d.reviewed_at,
        title: `Document ${d.status === 'REJECTED' ? 'rejected' : 'accepted'}: ${d.file_name}`,
        description: d.status === 'REJECTED' ? d.rejection_reason : d.review_comment,
        actorId: customer ? null : d.reviewed_by,
      })
    }
  }

  const requests = await ctx.db.findMany('artifact_requirements', { where: { claim_id: id, requested_at: { ne: null } } })
  for (const r of requests) {
    events.push({
      id: `req-${r.id}`,
      type: 'REQUEST',
      at: r.requested_at,
      title: r.requirement_type === 'DOCUMENT' ? `Document requested: ${humanize(r.doc_type)}` : 'Information requested',
      description: r.request_message,
      actorId: customer ? null : r.requested_by,
    })
  }

  if (!customer) {
    const audits = await ctx.db.findMany('audit_logs', {
      where: { claim_id: id, action: { nin: ['CLAIM_STATUS_CHANGED', 'NOTE_ADDED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REVIEWED', 'ARTIFACT_REQUESTED'] } },
      orderBy: [['occurred_at', 'asc']],
      limit: 300,
    })
    for (const a of audits) {
      events.push({ id: `audit-${a.id}`, type: 'AUDIT', at: a.occurred_at, title: humanize(a.action), description: a.metadata?.reason || a.metadata?.comments || null, actorId: a.actor_id })
    }
  }

  const names = customer ? {} : await profileMap(ctx.db, events.map((e) => e.actorId))
  return events
    .map((e) => ({ ...e, actorName: nameOf(names, e.actorId) }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

export async function deleteDraft(ctx, id) {
  return ctx.db.tx(async (t) => {
    const claim = await loadAccessibleClaim(t, ctx.actor, id, { forUpdate: true })
    if (claim.status !== 'DRAFT') throw businessRule('CLAIM_NOT_EDITABLE', 'Only drafts can be discarded')
    if (claim.customer_id !== ctx.actor.id && claim.created_by !== ctx.actor.id) throw notFound('Claim not found')
    return transitionClaim(ctx, t, claim, 'WITHDRAWN', { reason: 'Draft discarded by claimant' })
  })
}
