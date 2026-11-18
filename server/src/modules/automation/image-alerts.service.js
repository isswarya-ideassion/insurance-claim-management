import { AI_AGENTS } from '../../../../shared/constants.js'
import { businessRule, conflict, notFound } from '../../utils/errors.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireTab } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { logger } from '../../config/logger.js'
import { SEVERITY_FACTOR } from '../compliance/compliance.service.js'
import {
  CHECK_REASON_CODES,
  IMAGE_ALERT_APPLIED,
  IMAGE_FORENSICS_AGENT,
  IMAGE_FORENSICS_ENGINE,
  describeAlerts,
  fraudChecksOf,
  imageFraudAlertsSchema,
  isFraudAlert,
  isImageMime,
  scanClaimImages,
} from '../../services/intelligence/imageForensics.service.js'

/*
 * Beacon AI Image Forensics alerts: who may see them, and the one-click
 * "Accept Alert & Flag Fraud" action.
 *
 * Alerts are produced locally (services/intelligence/imageForensics.service.js)
 * and attached to intake-parser and triage-router runs, or recorded as their
 * own run from the document view. Accepting one is a human decision: it marks
 * the run ACCEPTED in ai_runs and records fraud flags on the claim for
 * compliance to review. It never rejects, holds or settles the claim.
 */

/** An unrelated upload is rejected through document review, not flagged as fraud. */
const notAFraudAlert = () =>
  businessRule('NOT_A_FRAUD_ALERT', 'Beacon found this file unrelated to the claim rather than tampered with. Reject the document instead of flagging fraud.')

/** Runs whose output may carry imageFraudAlerts. */
const ALERT_AGENTS = [AI_AGENTS.INTAKE_PARSER, AI_AGENTS.TRIAGE_ROUTER, IMAGE_FORENSICS_AGENT]
const SEVERITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 }
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The claim tab every alert-viewing role can open (Claims Ops, Claims Manager, Adjuster, Document Review). */
const ALERT_TAB = 'overview'

/**
 * Scans a claim's images for an agent run. Never fails the run: forensics is
 * an addition to the agent's answer, so a scan error is logged and the agent
 * result still stands.
 */
export async function imageAlertsForRun(db, claim, { documentId = null, requestId } = {}) {
  try {
    return imageFraudAlertsSchema.parse(await scanClaimImages(db, claim, { documentId }))
  } catch (err) {
    logger.warn('image forensics scan failed', { claimId: claim.id, documentId, error: err.message, requestId })
    return []
  }
}

/**
 * Records one fraud flag per reason code across the accepted alerts. A code
 * that is already flagged and unresolved on the claim is not duplicated.
 */
async function recordImageFraudFlags(t, ctx, claim, alerts, runId) {
  const codes = Object.fromEntries((await t.findMany('fraud_reason_codes', { where: { active: true } })).map((c) => [c.code, c]))
  const open = new Set((await t.findMany('claim_fraud_flags', { where: { claim_id: claim.id, resolved: false }, columns: ['code'] })).map((f) => f.code))
  const review = await t.findOne('reviews', { claim_id: claim.id, checkpoint_type: 'COMPLIANCE' }, { orderBy: [['created_at', 'desc']] })

  const byCode = new Map()
  for (const alert of alerts) {
    // Unrelated-document notices are never fraud flags.
    for (const check of fraudChecksOf(alert)) {
      const code = (CHECK_REASON_CODES[check.check] || [check.code]).find((c) => codes[c])
      if (!code) continue
      const entry = byCode.get(code) || { severity: 'LOW', evidence: [] }
      if (SEVERITY_ORDER[check.severity] > SEVERITY_ORDER[entry.severity]) entry.severity = check.severity
      entry.evidence.push(`${alert.fileName}: ${check.evidence}`)
      byCode.set(code, entry)
    }
  }

  const recorded = []
  for (const [code, entry] of byCode) {
    if (open.has(code)) continue
    await t.insert('claim_fraud_flags', {
      claim_id: claim.id,
      code,
      severity: entry.severity,
      contribution: Math.min(100, Math.max(0, Math.round(Number(codes[code].weight) * SEVERITY_FACTOR[entry.severity]))),
      note: clip(`Beacon image forensics alert accepted by staff: ${entry.evidence.join(' | ')}`, 1000),
      resolved: false,
      review_id: review?.id || null,
      ai_run_ref: runId,
      created_by: ctx.actor.id,
    })
    recorded.push(code)
  }
  return recorded
}

// ---------------------------------------------------------------------------
// Accept an alert attached to an agent run (AI Suggestion card)
// ---------------------------------------------------------------------------
export async function acceptRunImageAlert(ctx, runId) {
  requirePermission(ctx.actor, 'fraud.imageAlerts.accept')
  const run = await ctx.db.findById('ai_runs', runId)
  if (!run || !ALERT_AGENTS.includes(run.agent)) throw notFound('AI run not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, run.claim_id)
  requireTab(ctx.actor, claim, ALERT_TAB)
  requireNotOwnClaim(ctx.actor, claim)
  if (run.status !== 'SUCCEEDED') throw businessRule('AGENT_RUN_FAILED', 'A failed run has no alert to accept')

  const parsed = imageFraudAlertsSchema.safeParse(run.output?.imageFraudAlerts ?? [])
  const all = parsed.success ? parsed.data : []
  if (!all.length) throw businessRule('NO_IMAGE_ALERT', 'This suggestion has no image forensics alert to accept')
  const alerts = all.filter(isFraudAlert)
  if (!alerts.length) throw notAFraudAlert()

  return ctx.db.tx(async (t) => {
    const locked = await t.findOne('ai_runs', { id: run.id }, { forUpdate: true })
    const applied = locked.applied_fields || []
    if (applied.includes(IMAGE_ALERT_APPLIED)) throw conflict('This image alert has already been accepted', 'ALREADY_ACCEPTED')
    if (locked.human_decision === 'REJECTED') throw conflict('This suggestion was discarded; run the agent again to review a fresh alert', 'ALREADY_REVIEWED')

    // An accepted run keeps its original decider and time (the database
    // allows an accepted run only to gain applied parts).
    const [updated] = await t.update('ai_runs', { id: run.id }, {
      human_decision: 'ACCEPTED',
      applied_fields: [...applied, IMAGE_ALERT_APPLIED],
      decided_by: locked.decided_by || ctx.actor.id,
      decided_at: locked.decided_at || new Date(),
    })
    const flags = await recordImageFraudFlags(t, ctx, claim, alerts, run.id)
    await recordAudit(t, ctx.actor, {
      action: 'IMAGE_FRAUD_ALERT_ACCEPTED',
      entityType: 'ai_run',
      entityId: run.id,
      claimId: claim.id,
      metadata: { agent: run.agent, documents: alerts.map((a) => a.documentId), riskLevels: alerts.map((a) => a.riskLevel), fraudFlags: flags },
    })
    return { runId: updated.id, agent: updated.agent, human_decision: updated.human_decision, applied_fields: updated.applied_fields, fraudFlagsRecorded: flags }
  })
}

// ---------------------------------------------------------------------------
// Document Review view: live scan of one document, and accept from there
// ---------------------------------------------------------------------------
async function loadImageDocument(ctx, documentId) {
  const document = await ctx.db.findById('documents', documentId)
  if (!document) throw notFound('Document not found')
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, document.claim_id)
  requireTab(ctx.actor, claim, 'documents')
  return { document, claim }
}

async function acceptedRunFor(db, documentId) {
  const rows = await db.query(
    `select id, agent, decided_by, decided_at from public.ai_runs
      where document_id = $1 and $2 = any(applied_fields)
      order by created_at desc limit 1`,
    [documentId, IMAGE_ALERT_APPLIED],
  )
  return rows[0] || null
}

export async function getDocumentImageForensics(ctx, documentId) {
  requirePermission(ctx.actor, 'fraud.imageAlerts.view')
  const { document, claim } = await loadImageDocument(ctx, documentId)
  if (!isImageMime(document.mime_type)) {
    return { documentId, applicable: false, alert: null, accepted: null, canAccept: false, engine: IMAGE_FORENSICS_ENGINE }
  }
  const [alerts, accepted] = await Promise.all([imageAlertsForRun(ctx.db, claim, { documentId, requestId: ctx.actor.requestId }), acceptedRunFor(ctx.db, documentId)])
  const names = accepted ? await profileMap(ctx.db, [accepted.decided_by]) : {}
  return {
    documentId,
    claimNumber: claim.claim_number,
    applicable: true,
    alert: alerts[0] || null,
    accepted: accepted ? { runId: accepted.id, agent: accepted.agent, by: nameOf(names, accepted.decided_by), at: accepted.decided_at } : null,
    // An unrelated-document notice is answered by rejecting the document, not by flagging fraud.
    canAccept: claim.customer_id !== ctx.actor.id && Boolean(alerts[0] && isFraudAlert(alerts[0])),
    documentStatus: document.status,
    engine: IMAGE_FORENSICS_ENGINE,
  }
}

export async function acceptDocumentImageAlert(ctx, documentId) {
  requirePermission(ctx.actor, 'fraud.imageAlerts.accept')
  const { document, claim } = await loadImageDocument(ctx, documentId)
  requireNotOwnClaim(ctx.actor, claim)
  if (!isImageMime(document.mime_type)) throw businessRule('NOT_AN_IMAGE', 'Image forensics applies to image documents only')
  if (await acceptedRunFor(ctx.db, documentId)) throw conflict('An image alert for this document has already been accepted', 'ALREADY_ACCEPTED')

  const started = Date.now()
  const scanned = await imageAlertsForRun(ctx.db, claim, { documentId, requestId: ctx.actor.requestId })
  if (!scanned.length) throw businessRule('NO_IMAGE_ALERT', 'Beacon found no fraud indicators in this image')
  const alerts = scanned.filter(isFraudAlert)
  if (!alerts.length) throw notAFraudAlert()

  const result = await ctx.db.tx(async (t) => {
    const now = new Date()
    // The scan and the person's decision are one record: the alert shown on
    // screen is what was accepted.
    const run = await t.insert('ai_runs', {
      agent: IMAGE_FORENSICS_AGENT,
      prompt_version: IMAGE_FORENSICS_ENGINE,
      claim_id: claim.id,
      document_id: document.id,
      provider: 'beacon',
      model: IMAGE_FORENSICS_ENGINE,
      status: 'SUCCEEDED',
      input_hash: alerts[0].sha256,
      output: { imageFraudAlerts: alerts, summary: describeAlerts(alerts) },
      confidence: alerts[0].confidence,
      needs_human: true,
      human_decision: 'ACCEPTED',
      applied_fields: [IMAGE_ALERT_APPLIED],
      decided_by: ctx.actor.id,
      decided_at: now,
      latency_ms: Date.now() - started,
      requested_by: ctx.actor.id,
    })
    const flags = await recordImageFraudFlags(t, ctx, claim, alerts, run.id)
    await recordAudit(t, ctx.actor, {
      action: 'IMAGE_FRAUD_ALERT_ACCEPTED',
      entityType: 'ai_run',
      entityId: run.id,
      claimId: claim.id,
      metadata: { agent: IMAGE_FORENSICS_AGENT, documents: [document.id], riskLevels: alerts.map((a) => a.riskLevel), fraudFlags: flags },
    })
    return { runId: run.id, fraudFlagsRecorded: flags }
  })
  return { ...(await getDocumentImageForensics(ctx, documentId)), ...result }
}
