import { randomUUID } from 'node:crypto'
import {
  ACTIVE_STATUSES,
  AI_AGENTS,
  AUTOPILOT_ACTIONS,
  AUTOPILOT_FRAUD_REASONS,
  AUTOPILOT_STAGES,
  BEACON_AUTOPILOT_NAME,
  BEACON_AUTOPILOT_USER_ID,
  DOCUMENT_STAGE_STATUSES,
  INTAKE_STATUSES,
  OPEN_COMPLIANCE_STATUSES,
  ROLES,
  humanize,
} from '../../../../shared/constants.js'
import { businessRule, conflict } from '../../utils/errors.js'
import { formatInr, hoursFromNow } from '../../utils/format.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink, userIdsWithRole } from '../../services/notification.service.js'
import { pickLeastLoadedAdjuster } from '../../services/intakeRouting.service.js'
import { logger } from '../../config/logger.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { verifyCoverage } from '../claims/claims.service.js'
import { assignClaim } from '../assignments/assignments.service.js'
import { reviewDocument } from '../documents/documents.service.js'
import { precomputeAgentRun } from './agents.service.js'
import { ensureLatestScan } from './auto-extraction.service.js'
import { fraudChecksOf } from '../../services/intelligence/imageForensics.service.js'
import { RELEVANCE, assessRelevance } from '../../services/intelligence/documentRelevance.js'
import { readFileText } from '../../services/intelligence/documentIntelligence.service.js'

/*
 * Beacon AI Auto-Pilot: straight-through processing (STP) for routine work,
 * exception-only review for people.
 *
 * Every automated step goes through the same service a person would use
 * (verifyCoverage, assignClaim, reviewDocument), so the workflow guards, the
 * enforce_claim_status_rules trigger and the separation-of-duties rules apply
 * unchanged. The auto-pilot acts as the Beacon service account with only the
 * role of the person whose routine work it is doing at that step, and it is
 * audited as an AGENT.
 *
 * It never approves a reserve or settlement, issues or releases a payment,
 * verifies a payee, places a compliance hold, records fraud flags or denies a
 * claim. Anything uncertain is left for a person, with the AI analysis attached.
 */

export const AUTO_REJECT_REASON = 'Auto-rejected by Beacon AI: unnecessary or non-claim document'

/** Only the local Beacon provider runs unattended: a paid model would bill for every sweep. */
export const autopilotProviderReady = (ai) => Boolean(ai?.configured && ai.name === 'beacon')

/** The service identity acting with one role, for one step. */
export function autopilotActor(role, requestId = null) {
  return {
    id: BEACON_AUTOPILOT_USER_ID,
    type: 'AGENT',
    roles: [role],
    fullName: BEACON_AUTOPILOT_NAME,
    email: null,
    autopilot: true,
    requestId,
    ip: null,
  }
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ---------------------------------------------------------------------------
// Decisions (pure; unit-tested)
// ---------------------------------------------------------------------------

/**
 * Risk reasons that keep a claim away from straight-through processing.
 * `triage` is a triage-router run output; `risk` the stored fraud facts.
 */
export function stpBlockers({ claim, maxLoss, triage, risk = {} }) {
  const out = []
  const loss = claim.estimated_loss == null ? null : Number(claim.estimated_loss)
  if (loss == null || Number.isNaN(loss)) out.push({ code: 'NO_ESTIMATE', message: 'No estimated loss is recorded' })
  else if (loss > maxLoss) out.push({ code: 'ABOVE_STP_THRESHOLD', message: `Estimated loss ${formatInr(loss)} is above the ${formatInr(maxLoss)} straight-through limit` })
  if (claim.possible_duplicate_of) out.push({ code: 'POSSIBLE_DUPLICATE', message: 'Possible duplicate of another claim' })
  if (!triage) {
    out.push({ code: 'NO_TRIAGE', message: 'Triage could not be completed' })
  } else {
    const imageAlerts = (triage.imageFraudAlerts || []).filter((a) => fraudChecksOf(a).length > 0)
    if (imageAlerts.length) out.push({ code: 'IMAGE_FRAUD_ALERT', message: `Beacon image forensics raised ${imageAlerts.length} alert(s)` })
    if ((triage.fraudReasons || []).length || triage.aboveReviewThreshold || ['MEDIUM', 'HIGH'].includes(triage.fraudBand)) {
      out.push({ code: 'FRAUD_SIGNALS', message: `Fraud indicators from triage (${triage.fraudBand || 'band unknown'} band)` })
    }
  }
  if (risk.openFraudFlags > 0) out.push({ code: 'FRAUD_SIGNALS', message: `${risk.openFraudFlags} unresolved fraud flag(s) on the claim` })
  if (risk.ring) out.push({ code: 'FRAUD_RING', message: `Linked to a ${risk.ring.band.toLowerCase()}-risk fraud ring` })
  if (['UNUSUAL', 'EXTREME'].includes(risk.anomalyBand)) out.push({ code: 'ANOMALY', message: `Anomaly model rates the claim ${risk.anomalyBand.toLowerCase()}` })
  if (risk.complianceHold) out.push({ code: 'COMPLIANCE_HOLD', message: 'An active compliance hold is on the claim' })
  return out
}

/**
 * Unambiguous cover: the policy passed every hard check (active, in period,
 * owned by the claimant, claim and loss type match), a coverage clause names
 * the loss, and no exclusion does. The checker's own `needsHuman` is not used
 * here: Beacon sets it on every coverage call so that an interactive suggestion
 * always reaches a person, which would make straight-through intake impossible.
 * The facts behind it are checked instead.
 */
export function coverageUnambiguous(coverage) {
  return Boolean(
    coverage &&
      coverage.result === 'COVERED' &&
      coverage.hardChecks?.passed === true &&
      (coverage.coveringClauses || []).length > 0 &&
      (coverage.exclusionClauses || []).length === 0,
  )
}

/** Intake: coverage must be unambiguous and the claim free of risk signals. */
export function decideIntake({ claim, coverage, triage, risk, maxLoss }) {
  const blockers = []
  if (!coverage) blockers.push({ code: 'COVERAGE_UNCLEAR', message: 'The coverage check could not be completed' })
  else if (!coverageUnambiguous(coverage)) {
    const why =
      coverage.result !== 'COVERED' ? `returned ${humanize(coverage.result)}`
        : coverage.hardChecks?.passed !== true ? 'found failed policy checks'
          : (coverage.exclusionClauses || []).length ? 'matched an exclusion clause'
            : 'found no coverage clause naming the loss'
    blockers.push({ code: 'COVERAGE_UNCLEAR', message: `Coverage check ${why}` })
  }
  blockers.push(...stpBlockers({ claim, maxLoss, triage, risk }))
  return { automate: blockers.length === 0, blockers }
}

/** Routing: coverage already recorded as covered, and the same risk screen as intake. */
export function decideRouting({ claim, triage, risk, maxLoss }) {
  const blockers = []
  if (claim.coverage_result !== 'COVERED') blockers.push({ code: 'COVERAGE_UNCLEAR', message: 'Coverage is not recorded as covered' })
  blockers.push(...stpBlockers({ claim, maxLoss, triage, risk }))
  return { automate: blockers.length === 0, blockers }
}

/**
 * Document review: a fraud indicator always goes to a person; an unrelated file
 * is rejected; a file Beacon read and matched to the claim is accepted; anything
 * Beacon could not judge (unreadable, or a type it does not judge) goes to a person.
 */
export function decideDocument({ fraudAlerts = [], relevance, detail = null }) {
  const fraud = fraudAlerts.filter((a) => fraudChecksOf(a).length > 0)
  if (fraud.length) {
    const high = fraud.some((a) => a.riskLevel === 'HIGH')
    return { decision: 'ESCALATE', reasonCode: 'IMAGE_FRAUD_ALERT', highRisk: high, message: `Beacon image forensics: ${fraud.flatMap((a) => fraudChecksOf(a).map((c) => humanize(c.check))).join(', ')}` }
  }
  if (relevance === RELEVANCE.IRRELEVANT) return { decision: 'REJECT', reasonCode: 'IRRELEVANT', message: 'No claim evidence in this file' }
  if (relevance === RELEVANCE.RELEVANT) return { decision: 'ACCEPT', reasonCode: 'CLEAN_RELEVANT', message: 'Readable, matches the claim, no forensics findings' }
  return { decision: 'ESCALATE', reasonCode: 'UNREADABLE', highRisk: false, message: detail || 'Beacon could not read or judge this file' }
}

const PAYEE_CORROBORATING = ['NAME_MISMATCH', 'RECENT_BANK_CHANGE', 'THIRD_PARTY_PAYEE', 'PAYEE_ON_MULTIPLE_CLAIMS']

/** HIGH when the bank account is shared with another payee, or new bank details come with a mismatch signal. */
export function payeeRisk(output) {
  const codes = new Set([...(output?.signals || []), ...(output?.anomalies || []).map((a) => a.code)])
  if (codes.has('DUPLICATE_PAYEE')) return { level: 'HIGH', codes: [...codes] }
  if (codes.has('NEW_BANK_DETAILS') && PAYEE_CORROBORATING.some((c) => codes.has(c))) return { level: 'HIGH', codes: [...codes] }
  return { level: codes.size ? 'LOW' : 'NONE', codes: [...codes] }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function loadState(db) {
  return (await db.findOne('autopilot_state', { id: 1 })) || { id: 1, enabled: null }
}

/** The toggle once used; until then the AI_AUTOPILOT_ENABLED setting. */
export async function isAutopilotEnabled(deps) {
  const state = await loadState(deps.db)
  return state.enabled ?? Boolean(deps.config?.AI_AUTOPILOT_ENABLED)
}

export async function getAutopilotState(ctx) {
  requirePermission(ctx.actor, 'autopilot.view')
  const state = await loadState(ctx.db)
  return presentState(ctx, state)
}

function presentState(ctx, state) {
  return {
    enabled: state.enabled ?? Boolean(ctx.config?.AI_AUTOPILOT_ENABLED),
    providerReady: autopilotProviderReady(ctx.ai),
    provider: ctx.ai?.name || 'none',
    lifecycleTriggers: Boolean(ctx.config?.AI_AUTOPILOT_ENABLED),
    stpMaxLoss: Number(ctx.config?.AI_AUTOPILOT_STP_MAX_LOSS ?? 25_000),
    updatedAt: state.updated_at || null,
    lastSweepAt: state.last_sweep_at || null,
    lastSweep: state.last_sweep || null,
    serviceAccountId: BEACON_AUTOPILOT_USER_ID,
  }
}

export async function setAutopilotEnabled(ctx, { enabled }) {
  requirePermission(ctx.actor, 'autopilot.manage')
  return ctx.db.tx(async (t) => {
    const before = await t.findOne('autopilot_state', { id: 1 }, { forUpdate: true })
    const values = { enabled, updated_by: ctx.actor.id, updated_at: new Date() }
    const after = before ? await t.updateById('autopilot_state', 1, values) : await t.insert('autopilot_state', { id: 1, ...values })
    await recordAudit(t, ctx.actor, {
      action: enabled ? 'AI_AUTOPILOT_ENABLED' : 'AI_AUTOPILOT_DISABLED',
      entityType: 'autopilot',
      metadata: { from: before?.enabled ?? null, to: enabled },
    })
    return presentState(ctx, after)
  })
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Records one auto-pilot action: a row in autopilot_actions (the metrics
 * source) and an audit entry under the AGENT actor, in the caller's
 * transaction. Returns null when the dedupe key was already used.
 */
async function recordAction(t, actor, sweep, { action, claim, documentId = null, aiRunIds = [], reasonCode = null, reason = null, details = {}, dedupeKey = null }) {
  const def = AUTOPILOT_ACTIONS[action]
  const [row] = await t.query(
    `insert into public.autopilot_actions
       (sweep_id, stage, action, outcome, claim_id, document_id, ai_run_ids, reason_code, reason, minutes_saved, details, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10, $11::jsonb, $12)
     on conflict (dedupe_key) do nothing
     returning *`,
    [sweep.id, def.stage, action, def.outcome, claim.id, documentId, aiRunIds.filter(Boolean), reasonCode, reason ? clip(reason, 1000) : null, def.minutes, JSON.stringify(details), dedupeKey],
  )
  if (!row) return null
  await recordAudit(t, actor, {
    action,
    entityType: documentId ? 'document' : 'claim',
    entityId: documentId || claim.id,
    claimId: claim.id,
    metadata: {
      sweepId: sweep.id,
      trigger: sweep.trigger,
      requestedBy: sweep.requestedBy,
      stage: def.stage,
      outcome: def.outcome,
      aiRunIds: aiRunIds.filter(Boolean),
      reasonCode,
      reason: reason ? clip(reason, 500) : null,
      ...details,
    },
  })
  sweep.results.push({ action, stage: def.stage, outcome: def.outcome, claimId: claim.id, claimNumber: claim.claim_number, documentId, reasonCode })
  return row
}

async function addInternalNote(t, claim, body) {
  await t.insert('claim_notes', { claim_id: claim.id, author_id: BEACON_AUTOPILOT_USER_ID, visibility: 'INTERNAL', body: clip(body, 4000) })
}

/** Fraud and risk facts already stored for a claim (rings, flags, anomaly band, holds). */
async function riskFacts(db, claim) {
  const [[flags], rings, anomaly, [hold]] = await Promise.all([
    db.query('select count(*)::int as n from public.claim_fraud_flags where claim_id = $1 and not resolved', [claim.id]),
    db.query(
      `select r.id, r.band, r.score from public.fraud_rings r join public.fraud_ring_members m on m.ring_id = r.id
        where $1 = any(m.claim_ids) and r.status <> 'DISMISSED' and r.band in ('HIGH', 'CRITICAL')
        order by r.score desc limit 1`,
      [claim.id],
    ),
    db.query('select band from public.claim_anomaly_scores where claim_id = $1', [claim.id]),
    db.query(`select count(*)::int as n from public.reviews where claim_id = $1 and checkpoint_type = 'COMPLIANCE' and hold_active`, [claim.id]),
  ])
  return { openFraudFlags: flags.n, ring: rings[0] || null, anomalyBand: anomaly[0]?.band || null, complianceHold: hold.n > 0 }
}

/** Runs an agent for the auto-pilot; a failure is returned, not thrown, so the claim is escalated instead. */
async function tryAgent(ctx, claim, agent) {
  try {
    return { run: await precomputeAgentRun(ctx, claim, agent), error: null }
  } catch (err) {
    return { run: null, error: err }
  }
}

/**
 * Opens a pending compliance review flagged as an AI priority item, or marks
 * the open one. It never places a hold or records a fraud flag: compliance
 * decides what the indicators mean.
 */
async function flagForCompliance(ctx, t, claim, reason) {
  const open = await t.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE', status: { in: OPEN_COMPLIANCE_STATUSES } })
  const flagReason = clip(`Beacon AI Auto-Pilot: ${reason}`, 1000)
  const review = open
    ? await t.updateById('reviews', open.id, { ai_priority: true, ai_flag_reason: flagReason })
    : await t.insert('reviews', {
        claim_id: claim.id,
        checkpoint_type: 'COMPLIANCE',
        subject_type: 'claim',
        subject_id: claim.id,
        status: 'PENDING',
        comments: flagReason,
        ai_priority: true,
        ai_flag_reason: flagReason,
        created_by: BEACON_AUTOPILOT_USER_ID,
      })
  await notify(ctx, t, {
    recipientIds: await userIdsWithRole(t, ROLES.COMPLIANCE_SECURITY),
    claimId: claim.id,
    type: 'APPROVAL_REQUIRED',
    title: `AI-flagged priority: ${claim.claim_number}`,
    message: flagReason,
    link: `/claims/${claim.id}?tab=compliance`,
    email: false,
  })
  return review
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const claimFilter = (sweep, alias = 'c') => (sweep.claimId ? ` and ${alias}.id = '${sweep.claimId}'` : '')

/** 1. Intake & triage (Claims Operations Manager). */
async function intakeStage(deps, sweep) {
  const claims = await deps.db.query(
    `select c.* from public.claims c
      where c.status = any($1::text[]) and c.claim_number is not null and c.coverage_result is null
        and not exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.stage = 'INTAKE')${claimFilter(sweep)}
      order by c.opened_at asc limit $2`,
    [INTAKE_STATUSES, sweep.batch],
  )
  for (const claim of claims) {
    await step(sweep, 'INTAKE', claim, async () => {
      const actor = autopilotActor(ROLES.CLAIMS_OPS_MANAGER, sweep.requestId)
      const ctx = { ...deps, actor }
      const coverage = await tryAgent(ctx, claim, AI_AGENTS.COVERAGE_CHECKER)
      const triage = await tryAgent(ctx, claim, AI_AGENTS.TRIAGE_ROUTER)
      const risk = await riskFacts(deps.db, claim)
      const decision = decideIntake({ claim, coverage: coverage.run?.output, triage: triage.run?.output, risk, maxLoss: sweep.maxLoss })
      if (!claim.assigned_owner_id) decision.blockers.push({ code: 'NO_OWNER', message: 'No Claims Operations Manager owns this claim yet' })
      const runIds = [coverage.run?.id, triage.run?.id]

      if (decision.blockers.length === 0) {
        const out = coverage.run.output
        await deps.db.tx(async (t) => {
          const tctx = { ...ctx, db: t }
          await verifyCoverage(tctx, claim.id, {
            result: 'COVERED',
            notes: clip(`Verified straight-through by Beacon AI Auto-Pilot (${coverage.run.prompt_version}): ${out.rationale}`, 2000),
            clauseRefs: [...(out.coveringClauses || []), ...(out.exclusionClauses || [])].map((c) => c.id),
            aiRunRef: coverage.run.id,
          })
          await t.update('ai_runs', { id: coverage.run.id }, { human_decision: 'ACCEPTED', applied_fields: ['coverage_result'], decided_by: BEACON_AUTOPILOT_USER_ID, decided_at: new Date() })
          await recordAction(t, actor, sweep, {
            action: 'AI_AUTOPILOT_COVERAGE_VERIFIED',
            claim,
            aiRunIds: runIds,
            reasonCode: 'STP',
            reason: `Covered, ${formatInr(claim.estimated_loss)} within the straight-through limit, no fraud or anomaly signals`,
            details: { coverageResult: 'COVERED', fraudBand: triage.run.output.fraudBand },
            dedupeKey: `intake:${claim.id}`,
          })
          await notify(tctx, t, {
            recipientIds: [claim.assigned_owner_id],
            claimId: claim.id,
            type: 'CLAIM_STATUS_CHANGED',
            title: `Coverage verified by Beacon AI: ${claim.claim_number}`,
            message: 'Routine claim processed straight through. Complete the intake checklist and verify the payee to move it on.',
            link: claimLink(claim, false),
            email: false,
          })
        })
        return
      }

      const reasons = [...decision.blockers.map((b) => b.message), ...[coverage.error, triage.error].filter(Boolean).map((e) => e.message)]
      const fraud = decision.blockers.find((b) => AUTOPILOT_FRAUD_REASONS.includes(b.code))
      await deps.db.tx(async (t) => {
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_INTAKE_ESCALATED',
          claim,
          aiRunIds: runIds,
          reasonCode: fraud?.code || decision.blockers[0]?.code || 'AGENT_FAILED',
          reason: reasons.join('; '),
          details: { blockers: decision.blockers.map((b) => b.code), coverageResult: coverage.run?.output?.result ?? null },
          dedupeKey: `intake:${claim.id}`,
        })
        if (!recorded) return
        await addInternalNote(t, claim, `Beacon AI Auto-Pilot left intake for a person: ${reasons.join('; ')}. The coverage check and triage are attached on the Policy & Coverage and Overview tabs.`)
        await notify({ ...ctx, db: t }, t, {
          recipientIds: claim.assigned_owner_id ? [claim.assigned_owner_id] : await userIdsWithRole(t, ROLES.CLAIMS_OPS_MANAGER),
          claimId: claim.id,
          type: 'TASK_ASSIGNED',
          title: `Needs your review: ${claim.claim_number}`,
          message: clip(`Beacon AI could not process this claim straight through: ${reasons.join('; ')}`, 500),
          link: claimLink(claim, false),
          email: false,
        })
      })
    })
  }
}

/** 2. Adjuster routing (Claims Operations Manager): least-loaded adjuster for clean, low-value claims. */
async function routingStage(deps, sweep) {
  const claims = await deps.db.query(
    `select c.* from public.claims c
      where c.status = 'ADJUSTER_ASSIGNMENT' and c.assigned_adjuster_id is null
        and not exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.stage = 'ROUTING')${claimFilter(sweep)}
      order by c.opened_at asc limit $1`,
    [sweep.batch],
  )
  for (const claim of claims) {
    await step(sweep, 'ROUTING', claim, async () => {
      const actor = autopilotActor(ROLES.CLAIMS_OPS_MANAGER, sweep.requestId)
      const ctx = { ...deps, actor }
      const triage = await tryAgent(ctx, claim, AI_AGENTS.TRIAGE_ROUTER)
      const risk = await riskFacts(deps.db, claim)
      const decision = decideRouting({ claim, triage: triage.run?.output, risk, maxLoss: sweep.maxLoss })
      const pick = decision.automate ? await pickLeastLoadedAdjuster(deps.db, claim) : null
      if (decision.automate && !pick) decision.blockers.push({ code: 'NO_ADJUSTER', message: 'No active adjuster is available' })

      if (decision.blockers.length === 0) {
        await deps.db.tx(async (t) => {
          const reason = `Auto-assigned by Beacon AI: least-loaded adjuster (${pick.open_claims} open claims, ${pick.open_tasks} open tasks)`
          const result = await assignClaim({ ...ctx, db: t }, claim.id, { assigneeId: pick.id, assignmentRole: 'ADJUSTER', reason })
          await recordAction(t, actor, sweep, {
            action: 'AI_AUTOPILOT_ADJUSTER_ASSIGNED',
            claim,
            aiRunIds: [triage.run.id],
            reasonCode: 'STP',
            reason,
            details: { adjusterId: pick.id, adjusterName: pick.full_name, assignmentId: result.assignment.id, statusAfter: result.claim.status },
            dedupeKey: `routing:${claim.id}`,
          })
        })
        return
      }

      const reasons = [...decision.blockers.map((b) => b.message), triage.error?.message].filter(Boolean)
      const fraud = decision.blockers.find((b) => AUTOPILOT_FRAUD_REASONS.includes(b.code))
      await deps.db.tx(async (t) => {
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_ROUTING_ESCALATED',
          claim,
          aiRunIds: [triage.run?.id],
          reasonCode: fraud?.code || decision.blockers[0]?.code || 'AGENT_FAILED',
          reason: reasons.join('; '),
          details: { blockers: decision.blockers.map((b) => b.code) },
          dedupeKey: `routing:${claim.id}`,
        })
        if (recorded) await addInternalNote(t, claim, `Beacon AI Auto-Pilot left adjuster routing for a person: ${reasons.join('; ')}. The triage suggestion is attached on the Overview tab.`)
      })
    })
  }
}

/** The relevance of a document: from its Beacon run when recorded there, otherwise read from the file. */
async function relevanceOf(deps, document, claim, run) {
  const recorded = run?.output?.relevance
  if (recorded?.status) return { status: recorded.status, detail: recorded.detail || null }
  try {
    const policy = claim.policy_id ? await deps.db.findById('policies', claim.policy_id) : null
    const buffer = await deps.storage.get(document.storage_key)
    const r = assessRelevance({ read: readFileText(buffer, document.mime_type), docType: document.doc_type, claim, policy })
    return { status: r.status, detail: r.detail || null }
  } catch {
    return { status: RELEVANCE.UNKNOWN, detail: 'The file could not be read, so its relevance was not judged.' }
  }
}

/** 3. Document review (Document Reviewer). */
async function documentStage(deps, sweep) {
  const docs = await deps.db.query(
    `select d.* from public.documents d join public.claims c on c.id = d.claim_id
      where d.status = 'PENDING_REVIEW' and d.ai_escalated_at is null and d.uploaded_by <> $3
        and c.status = any($1::text[])${claimFilter(sweep)}
      order by d.received_at asc limit $2`,
    [DOCUMENT_STAGE_STATUSES, sweep.batch, BEACON_AUTOPILOT_USER_ID],
  )
  for (const document of docs) {
    const claim = await deps.db.findById('claims', document.claim_id)
    await step(sweep, 'DOCUMENT_REVIEW', claim, async () => {
      const actor = autopilotActor(ROLES.DOCUMENT_REVIEWER, sweep.requestId)
      const ctx = { ...deps, actor }
      // OCR + image forensics + relevance: the Beacon intake-parser run for this version (scanned now if missing).
      const { run, errorCode } = await ensureLatestScan(ctx, document, claim, 'AUTOPILOT')
      const usable = run?.status === 'SUCCEEDED' ? run : null
      const fraudAlerts = (usable?.output?.imageFraudAlerts || []).filter((a) => a.documentId === document.id)
      const judged = usable ? await relevanceOf(deps, document, claim, usable) : { status: RELEVANCE.UNKNOWN, detail: 'Beacon could not scan this file.' }
      const relevance = judged.status
      const decision = decideDocument({ fraudAlerts, relevance, detail: judged.detail })
      const dedupeKey = `doc:${document.id}:v${document.version}`
      const docLabel = `${humanize(document.doc_type)} "${document.file_name}"`

      if (decision.decision === 'ACCEPT' || decision.decision === 'REJECT') {
        const accept = decision.decision === 'ACCEPT'
        await deps.db.tx(async (t) => {
          await reviewDocument(
            { ...ctx, db: t },
            document.id,
            accept
              ? { decision: 'ACCEPT', comment: `Auto-accepted by Beacon AI: ${decision.message}` }
              : { decision: 'REJECT', rejectionReason: AUTO_REJECT_REASON, comment: 'Beacon AI found no invoice, medical, repair or policy details matching this claim.', beaconFlag: 'IRRELEVANT_DOCUMENT' },
            // A rejection's follow-up goes to the claim's reviewer, or the Document Review queue.
            { followUpOwnerId: claim.assigned_reviewer_id || null },
          )
          await recordAction(t, actor, sweep, {
            action: accept ? 'AI_AUTOPILOT_DOC_ACCEPTED' : 'AI_AUTOPILOT_DOC_REJECTED',
            claim,
            documentId: document.id,
            aiRunIds: [usable.id],
            reasonCode: decision.reasonCode,
            reason: `${docLabel}: ${decision.message}`,
            details: { docType: document.doc_type, version: document.version, relevance },
            dedupeKey,
          })
        })
        return
      }

      const reason = errorCode ? `${decision.message} (scan failed: ${errorCode})` : decision.message
      await deps.db.tx(async (t) => {
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_DOC_ESCALATED',
          claim,
          documentId: document.id,
          aiRunIds: [usable?.id],
          reasonCode: decision.reasonCode,
          reason: `${docLabel}: ${reason}`,
          details: { docType: document.doc_type, version: document.version, relevance, highRisk: decision.highRisk, riskLevels: fraudAlerts.map((a) => a.riskLevel) },
          dedupeKey,
        })
        if (!recorded) return
        // Escalated documents go to the top of the human Review Queue.
        await t.updateById('documents', document.id, { ai_escalated_at: new Date(), ai_escalation_reason: clip(reason, 500) })
        const recipients = document.reviewer_id || claim.assigned_reviewer_id
        await notify({ ...ctx, db: t }, t, {
          recipientIds: recipients ? [recipients] : await userIdsWithRole(t, ROLES.DOCUMENT_REVIEWER),
          claimId: claim.id,
          type: 'TASK_ASSIGNED',
          title: decision.reasonCode === 'IMAGE_FRAUD_ALERT' ? `Fraud alert on ${claim.claim_number}: review first` : `Needs human review: ${document.file_name}`,
          message: clip(`Beacon AI escalated ${docLabel}: ${reason}`, 500),
          link: `/claims/${claim.id}?tab=documents`,
          email: false,
        })
      })
    })
  }
}

/**
 * 3b. "Documents complete — triage" (Document Reviewer) for claims whose
 * documents are all decided and required ones accepted, with nothing requested
 * from the client and no risk signals. The workflow guard (requiredDocumentsAccepted)
 * is checked again by transitionClaim.
 */
async function documentsCompleteStage(deps, sweep) {
  const claims = await deps.db.query(
    `select c.* from public.claims c
      where c.status = 'DOCUMENT_REVIEW'
        and not exists (select 1 from public.documents d where d.claim_id = c.id and d.status = 'PENDING_REVIEW')
        and exists (select 1 from public.documents d where d.claim_id = c.id and d.status = 'ACCEPTED')
        and not exists (select 1 from public.artifact_requirements r where r.claim_id = c.id and r.status = 'REQUESTED')
        and not exists (select 1 from public.artifact_requirements r where r.claim_id = c.id and r.is_required and r.status not in ('ACCEPTED', 'WAIVED'))
        and not exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.action = 'AI_AUTOPILOT_DOCS_COMPLETE')${claimFilter(sweep)}
      order by c.updated_at asc limit $1`,
    [sweep.batch],
  )
  for (const claim of claims) {
    await step(sweep, 'DOCUMENT_REVIEW', claim, async () => {
      const risk = await riskFacts(deps.db, claim)
      if (risk.openFraudFlags || risk.ring || risk.complianceHold || ['UNUSUAL', 'EXTREME'].includes(risk.anomalyBand)) return
      const actor = autopilotActor(ROLES.DOCUMENT_REVIEWER, sweep.requestId)
      await deps.db.tx(async (t) => {
        const ctx = { ...deps, actor, db: t }
        const locked = await lockClaim(t, claim.id)
        if (locked.status !== 'DOCUMENT_REVIEW') return
        const reason = 'Documents complete — every required document accepted (Beacon AI Auto-Pilot)'
        await transitionClaim(ctx, t, locked, 'ADJUSTER_ASSIGNMENT', { reason })
        await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_DOCS_COMPLETE',
          claim,
          reasonCode: 'STP',
          reason,
          dedupeKey: `docs-complete:${claim.id}:${claim.reopen_count || 0}`,
        })
      })
    })
  }
}

/** 4. Adjuster pre-work (Adjuster): reserve bands and subrogation insights ready when the adjuster opens the claim. */
async function preworkStage(deps, sweep) {
  const claims = await deps.db.query(
    `select c.* from public.claims c
      where c.status = 'INVESTIGATION' and c.assigned_adjuster_id is not null
        and not exists (select 1 from public.ai_runs r where r.claim_id = c.id and r.agent = $1)
        and not exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.stage = 'ADJUSTER_PREWORK')${claimFilter(sweep)}
      order by c.updated_at asc limit $2`,
    [AI_AGENTS.RESERVE_RECOMMENDER, sweep.batch],
  )
  for (const claim of claims) {
    await step(sweep, 'ADJUSTER_PREWORK', claim, async () => {
      const actor = autopilotActor(ROLES.ADJUSTER, sweep.requestId)
      const ctx = { ...deps, actor }
      const reserve = await tryAgent(ctx, claim, AI_AGENTS.RESERVE_RECOMMENDER)
      const hasSubrogation = (await deps.db.count('ai_runs', { claim_id: claim.id, agent: AI_AGENTS.SUBROGATION_ASSESSOR })) > 0
      const subrogation = hasSubrogation ? { run: null, error: null, skipped: true } : await tryAgent(ctx, claim, AI_AGENTS.SUBROGATION_ASSESSOR)
      const ready = [reserve.run && 'reserve bands', subrogation.run && 'subrogation insights'].filter(Boolean)
      if (!ready.length) {
        logger.warn('autopilot pre-work produced nothing', { claimId: claim.id, reserve: reserve.error?.code, subrogation: subrogation.error?.code, requestId: sweep.requestId })
        return
      }
      await deps.db.tx(async (t) => {
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_PRECOMPUTED',
          claim,
          aiRunIds: [reserve.run?.id, subrogation.run?.id],
          reasonCode: 'PREWORK',
          reason: `Pre-computed ${ready.join(' and ')} for the adjuster to accept or override`,
          details: {
            reserveLines: reserve.run?.output?.lines?.map((l) => ({ coverageLine: l.coverageLine, low: l.low, point: l.point, high: l.high })) || [],
            recoveryLikelihood: subrogation.run?.output?.recoveryLikelihood || null,
          },
          dedupeKey: `prework:${claim.id}`,
        })
        if (!recorded) return
        await notify({ ...ctx, db: t }, t, {
          recipientIds: [claim.assigned_adjuster_id],
          claimId: claim.id,
          type: 'INVESTIGATION_UPDATE',
          title: `Pre-work ready: ${claim.claim_number}`,
          message: `Beacon AI prepared ${ready.join(' and ')}. Review and accept or override them on the claim.`,
          link: `/claims/${claim.id}?tab=reserves`,
          email: false,
        })
      })
    })
  }
}

/** 5a. Payee shield (Payment Operator): screen unverified payees before payout. */
async function payeeStage(deps, sweep) {
  const rows = await deps.db.query(
    `select c.*, p.id as screen_payee_id, p.bank_details_changed_at as screen_bank_changed_at
       from public.claims c
       join public.policies pol on pol.id = c.policy_id
       join public.payees p on p.id = pol.payee_id
      where c.status = any($1::text[]) and p.verification_status <> 'VERIFIED' and p.bank_details_encrypted is not null${claimFilter(sweep)}
      order by c.updated_at asc limit $2`,
    [ACTIVE_STATUSES, sweep.batch * 4],
  )
  const keyOf = (r) => `payee:${r.id}:${r.screen_payee_id}:${r.screen_bank_changed_at ? new Date(r.screen_bank_changed_at).toISOString() : 'none'}`
  const done = new Set(
    rows.length ? (await deps.db.query('select dedupe_key from public.autopilot_actions where dedupe_key = any($1::text[])', [rows.map(keyOf)])).map((r) => r.dedupe_key) : [],
  )
  for (const row of rows.filter((r) => !done.has(keyOf(r))).slice(0, sweep.batch)) {
    const { screen_payee_id: payeeId, screen_bank_changed_at: _changed, ...claim } = row
    await step(sweep, 'PAYEE_SHIELD', claim, async () => {
      const actor = autopilotActor(ROLES.PAYMENT_OPERATOR, sweep.requestId)
      const ctx = { ...deps, actor }
      const { run, error } = await tryAgent(ctx, claim, AI_AGENTS.PAYEE_ANOMALY)
      if (!run) {
        logger.warn('autopilot payee screen failed', { claimId: claim.id, code: error?.code, requestId: sweep.requestId })
        return
      }
      const risk = payeeRisk(run.output)
      await deps.db.tx(async (t) => {
        if (risk.level !== 'HIGH') {
          await recordAction(t, actor, sweep, {
            action: 'AI_AUTOPILOT_PAYEE_SCREENED',
            claim,
            aiRunIds: [run.id],
            reasonCode: 'NO_HIGH_RISK',
            reason: risk.codes.length ? `No high-risk pattern (signals: ${risk.codes.map(humanize).join(', ')})` : 'No anomaly signals',
            details: { payeeId, signals: risk.codes },
            dedupeKey: keyOf(row),
          })
          return
        }
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_PAYEE_FLAGGED',
          claim,
          aiRunIds: [run.id],
          reasonCode: 'HIGH_RISK_PAYEE',
          reason: `High-risk payee pattern: ${risk.codes.map(humanize).join(', ')}`,
          details: { payeeId, signals: risk.codes },
          dedupeKey: keyOf(row),
        })
        if (!recorded) return
        const task = await t.insert('tasks', {
          claim_id: claim.id,
          title: clip(`AI-flagged payee: ${risk.codes.map(humanize).join(', ')}`, 200),
          description: clip(
            `Beacon AI Auto-Pilot flagged this payee before payout. Verify the bank details with the owner before the payee is verified.\n\n${(run.output.anomalies || []).map((a) => `${humanize(a.code)}: ${a.evidence}`).join('\n')}`,
            3000,
          ),
          type: 'PAYMENT',
          owner_role: ROLES.PAYMENT_OPERATOR,
          due_at: hoursFromNow(24),
          priority: 'HIGH',
          source_stage: claim.stage,
          created_by: BEACON_AUTOPILOT_USER_ID,
        })
        await flagForCompliance({ ...ctx, db: t }, t, claim, `high-risk payee pattern (${risk.codes.map(humanize).join(', ')})`)
        await notify({ ...ctx, db: t }, t, {
          recipientIds: await userIdsWithRole(t, ROLES.PAYMENT_OPERATOR),
          claimId: claim.id,
          type: 'TASK_ASSIGNED',
          title: `AI-flagged payee on ${claim.claim_number}`,
          message: `Review the payee before payout: ${risk.codes.map(humanize).join(', ')}.`,
          link: `/claims/${claim.id}?tab=approvals`,
          email: false,
        })
        logger.info('autopilot payee flagged', { claimId: claim.id, taskId: task.id, requestId: sweep.requestId })
      })
    })
  }
}

/** 5b. Fraud shield (Compliance & Security): high image-forensics risk or a high-risk fraud ring. */
async function fraudShieldStage(deps, sweep) {
  const claims = await deps.db.query(
    `select c.*,
            exists (select 1 from public.ai_runs r, jsonb_array_elements(case when jsonb_typeof(r.output -> 'imageFraudAlerts') = 'array' then r.output -> 'imageFraudAlerts' else '[]'::jsonb end) a
                     where r.claim_id = c.id and r.status = 'SUCCEEDED' and a ->> 'riskLevel' = 'HIGH'
                       and coalesce(a ->> 'relevance', 'RELEVANT') <> 'IRRELEVANT') as image_high,
            (select r.band from public.fraud_rings r join public.fraud_ring_members m on m.ring_id = r.id
              where c.id = any(m.claim_ids) and r.status <> 'DISMISSED' and r.band in ('HIGH', 'CRITICAL')
              order by r.score desc limit 1) as ring_band
       from public.claims c
      where c.status = any($1::text[])${claimFilter(sweep)}
        and not exists (select 1 from public.autopilot_actions x where x.claim_id = c.id and x.stage = 'FRAUD_SHIELD')
        and (exists (select 1 from public.ai_runs r, jsonb_array_elements(case when jsonb_typeof(r.output -> 'imageFraudAlerts') = 'array' then r.output -> 'imageFraudAlerts' else '[]'::jsonb end) a
                      where r.claim_id = c.id and r.status = 'SUCCEEDED' and a ->> 'riskLevel' = 'HIGH'
                        and coalesce(a ->> 'relevance', 'RELEVANT') <> 'IRRELEVANT')
             or exists (select 1 from public.fraud_rings r join public.fraud_ring_members m on m.ring_id = r.id
                         where c.id = any(m.claim_ids) and r.status <> 'DISMISSED' and r.band in ('HIGH', 'CRITICAL')))
      order by c.updated_at desc limit $2`,
    [[...ACTIVE_STATUSES, 'ON_HOLD'], sweep.batch],
  )
  for (const row of claims) {
    const { image_high: imageHigh, ring_band: ringBand, ...claim } = row
    await step(sweep, 'FRAUD_SHIELD', claim, async () => {
      const actor = autopilotActor(ROLES.COMPLIANCE_SECURITY, sweep.requestId)
      const reasons = [imageHigh && 'high-risk Beacon image forensics alert', ringBand && `member of a ${ringBand.toLowerCase()}-risk fraud ring`].filter(Boolean)
      await deps.db.tx(async (t) => {
        const recorded = await recordAction(t, actor, sweep, {
          action: 'AI_AUTOPILOT_COMPLIANCE_FLAGGED',
          claim,
          reasonCode: imageHigh ? 'IMAGE_FRAUD_ALERT' : 'FRAUD_RING',
          reason: `High combined fraud risk: ${reasons.join(' and ')}`,
          details: { imageHigh, ringBand: ringBand || null },
          dedupeKey: `compliance:${claim.id}`,
        })
        if (!recorded) return
        const review = await flagForCompliance({ ...deps, actor, db: t }, t, claim, `high combined fraud risk (${reasons.join(' and ')})`)
        await addInternalNote(t, claim, `Beacon AI Auto-Pilot flagged this claim to Compliance as a priority item: ${reasons.join(' and ')}. No hold was placed; Compliance decides.`)
        logger.info('autopilot compliance flag', { claimId: claim.id, reviewId: review.id, requestId: sweep.requestId })
      })
    })
  }
}

const STAGES = [
  ['INTAKE', intakeStage],
  ['DOCUMENT_REVIEW', documentStage],
  ['DOCUMENTS_COMPLETE', documentsCompleteStage],
  ['ROUTING', routingStage],
  ['ADJUSTER_PREWORK', preworkStage],
  ['PAYEE_SHIELD', payeeStage],
  ['FRAUD_SHIELD', fraudShieldStage],
]

/** Runs one item; a failure is logged and counted, never stops the sweep. */
async function step(sweep, stage, claim, fn) {
  try {
    await fn()
  } catch (err) {
    sweep.errors.push({ stage, claimId: claim?.id, claimNumber: claim?.claim_number, code: err.code || 'ERROR', message: clip(err.message, 300) })
    logger.warn('autopilot step failed', { stage, claimId: claim?.id, code: err.code, error: err.message, requestId: sweep.requestId })
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

// One sweep at a time per process; a sweep asked for while one runs waits for it.
let queue = Promise.resolve()

/**
 * Runs every stage once. `claimId` limits the sweep to one claim (lifecycle
 * triggers). Returns a summary of what was automated and escalated.
 */
export function runAutopilotSweep(deps, { trigger = 'SCHEDULED', requestedBy = null, claimId = null, requestId = null, force = false } = {}) {
  const job = queue.then(() => sweepOnce(deps, { trigger, requestedBy, claimId, requestId, force }))
  queue = job.catch(() => {})
  return job
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function sweepOnce(deps, { trigger, requestedBy, claimId, requestId, force }) {
  // claimId is interpolated into stage queries as a literal, so it must be a plain UUID.
  if (claimId && !UUID.test(claimId)) throw businessRule('INVALID_CLAIM', 'Invalid claim id')
  if (!autopilotProviderReady(deps.ai)) return { ran: false, reason: 'PROVIDER_NOT_BEACON' }
  if (!force && !(await isAutopilotEnabled(deps))) return { ran: false, reason: 'DISABLED' }
  const sweep = {
    id: randomUUID(),
    trigger,
    requestedBy,
    claimId,
    requestId: requestId || `autopilot-${trigger.toLowerCase()}`,
    batch: Number(deps.config?.AI_AUTOPILOT_BATCH_SIZE ?? 25),
    maxLoss: Number(deps.config?.AI_AUTOPILOT_STP_MAX_LOSS ?? 25_000),
    results: [],
    errors: [],
  }
  const started = Date.now()
  for (const [, stage] of STAGES) await stage(deps, sweep)

  const summary = {
    ran: true,
    sweepId: sweep.id,
    trigger,
    claimId,
    durationMs: Date.now() - started,
    automated: sweep.results.filter((r) => r.outcome === 'AUTOMATED').length,
    escalated: sweep.results.filter((r) => r.outcome === 'ESCALATED').length,
    minutesSaved: sweep.results.reduce((sum, r) => sum + (AUTOPILOT_ACTIONS[r.action]?.minutes || 0), 0),
    byStage: Object.fromEntries(Object.keys(AUTOPILOT_STAGES).map((s) => [s, {
      automated: sweep.results.filter((r) => r.stage === s && r.outcome === 'AUTOMATED').length,
      escalated: sweep.results.filter((r) => r.stage === s && r.outcome === 'ESCALATED').length,
    }])),
    actions: sweep.results.slice(0, 100),
    errors: sweep.errors.slice(0, 50),
  }
  if (!claimId) {
    await deps.db.update('autopilot_state', { id: 1 }, { last_sweep_at: new Date(), last_sweep: { ...summary, actions: summary.actions.slice(0, 25) } })
  }
  if (summary.automated || summary.escalated || summary.errors.length) {
    logger.info('autopilot sweep complete', { sweepId: sweep.id, trigger, automated: summary.automated, escalated: summary.escalated, errors: summary.errors.length })
  }
  return summary
}

/** POST /automation/autopilot/run: a person starts a sweep (works even while switched off only when forced by a manager). */
export async function triggerAutopilotSweep(ctx, { claimId = null } = {}) {
  requirePermission(ctx.actor, 'autopilot.run')
  if (!autopilotProviderReady(ctx.ai)) {
    throw businessRule('AUTOPILOT_UNAVAILABLE', 'Beacon AI Auto-Pilot needs AI_PROVIDER=beacon (the local, zero-cost provider).')
  }
  if (!(await isAutopilotEnabled(ctx))) throw conflict('Beacon AI Auto-Pilot is switched off. Turn it on to run a sweep.', 'AUTOPILOT_DISABLED')
  const result = await runAutopilotSweep(ctx, { trigger: 'MANUAL', requestedBy: ctx.actor.id, claimId, requestId: ctx.actor.requestId })
  await recordAudit(ctx.db, ctx.actor, {
    action: 'AI_AUTOPILOT_SWEEP_RUN',
    entityType: 'autopilot',
    claimId,
    metadata: { sweepId: result.sweepId, automated: result.automated, escalated: result.escalated, minutesSaved: result.minutesSaved, errors: result.errors?.length || 0 },
  })
  return result
}

/** Scheduled job: runs only while the auto-pilot is on and Beacon is the provider. */
export async function runScheduledAutopilot(deps) {
  return runAutopilotSweep(deps, { trigger: 'SCHEDULED' })
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** GET /automation/autopilot/summary: live optimization metrics. */
export async function getAutopilotSummary(ctx, { days = 30 } = {}) {
  requirePermission(ctx.actor, 'autopilot.view')
  const since = new Date(Date.now() - days * 86_400_000)
  const [byAction, [exceptions], recent, state] = await Promise.all([
    ctx.db.query(
      `select action, stage, outcome, reason_code, count(*)::int as n, coalesce(sum(minutes_saved), 0)::int as minutes
         from public.autopilot_actions where created_at >= $1 group by action, stage, outcome, reason_code`,
      [since],
    ),
    ctx.db.query(
      `select
         (select count(*) from public.documents where status = 'PENDING_REVIEW' and ai_escalated_at is not null)::int as documents,
         (select count(*) from public.claims c where c.status = any($1::text[]) and (c.coverage_result is null or c.coverage_result <> 'COVERED')
            and exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.action = 'AI_AUTOPILOT_INTAKE_ESCALATED'))::int as intake,
         (select count(*) from public.claims c where c.status = 'ADJUSTER_ASSIGNMENT' and c.assigned_adjuster_id is null
            and exists (select 1 from public.autopilot_actions a where a.claim_id = c.id and a.action = 'AI_AUTOPILOT_ROUTING_ESCALATED'))::int as routing,
         (select count(*) from public.reviews where checkpoint_type = 'COMPLIANCE' and ai_priority and status = any($2::text[]))::int as compliance,
         (select count(*) from public.tasks where created_by = $3 and status in ('OPEN', 'IN_PROGRESS'))::int as payee`,
      [INTAKE_STATUSES, OPEN_COMPLIANCE_STATUSES, BEACON_AUTOPILOT_USER_ID],
    ),
    ctx.db.query(
      `select a.id, a.created_at, a.stage, a.action, a.outcome, a.reason_code, a.reason, a.claim_id, a.document_id, c.claim_number
         from public.autopilot_actions a join public.claims c on c.id = a.claim_id
        order by a.created_at desc limit 12`,
    ),
    loadState(ctx.db),
  ])

  const stages = Object.fromEntries(
    Object.entries(AUTOPILOT_STAGES).map(([key, s]) => [key, { label: s.label, role: s.role, automated: 0, escalated: 0, minutesSaved: 0 }]),
  )
  let automated = 0
  let escalated = 0
  let minutes = 0
  let fraudCaught = 0
  let docsAutoHandled = 0
  for (const r of byAction) {
    const s = stages[r.stage]
    if (r.outcome === 'AUTOMATED') {
      automated += r.n
      if (s) s.automated += r.n
      if (r.stage === 'DOCUMENT_REVIEW') docsAutoHandled += r.n
    } else {
      escalated += r.n
      if (s) s.escalated += r.n
      if (AUTOPILOT_FRAUD_REASONS.includes(r.reason_code)) fraudCaught += r.n
    }
    minutes += r.minutes
    if (s) s.minutesSaved += r.minutes
  }
  const exceptionsRemaining = exceptions.documents + exceptions.intake + exceptions.routing + exceptions.compliance + exceptions.payee
  return {
    ...presentState(ctx, state),
    windowDays: days,
    totals: {
      routineTasksAutomated: automated,
      docsAutoHandled,
      escalated,
      fraudAlertsCaught: fraudCaught,
      humanExceptionsRemaining: exceptionsRemaining,
      minutesSaved: minutes,
      hoursSaved: Math.round((minutes / 60) * 10) / 10,
      // Share of the routine decisions the auto-pilot saw that it could complete on its own.
      stpRate: automated + escalated ? Math.round((automated / (automated + escalated)) * 100) : null,
    },
    stages,
    exceptions,
    recent: recent.map((r) => ({ ...r, label: AUTOPILOT_ACTIONS[r.action]?.label || humanize(r.action) })),
  }
}
