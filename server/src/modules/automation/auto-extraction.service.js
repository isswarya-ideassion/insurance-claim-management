import { AI_AGENTS } from '../../../../shared/constants.js'
import { notFound } from '../../utils/errors.js'
import { requirePermission, requireNotOwnClaim } from '../../services/access.service.js'
import { profileMap } from '../../services/presenters.js'
import { logger } from '../../config/logger.js'
import { extractDocument, loadAutomationClaim, presentRun } from './ai-automation.service.js'

/*
 * Automatic document scan: Beacon's intake-parser (local OCR + image
 * forensics) runs once per document version without anyone clicking
 * "Extract fields" — right after upload, and again on first view as a
 * fallback for documents uploaded before this existed or while Beacon was off.
 *
 * Only the local Beacon provider scans automatically. A paid model provider
 * would bill for every upload, so with one configured a person still starts
 * each extraction by hand.
 */

export const autoScanEnabled = (ai) => Boolean(ai?.configured && ai.name === 'beacon')

// One scan per document version at a time, so the upload scan and a reviewer
// opening the claim at the same moment share the same run instead of racing.
const inFlight = new Map()

/** The newest intake-parser run for the document's current version, if any. */
async function latestRunFor(db, document) {
  const rows = await db.query(
    `select * from public.ai_runs
      where document_id = $1 and agent = $2 and created_at >= $3
      order by created_at desc limit 1`,
    [document.id, AI_AGENTS.INTAKE_PARSER, document.received_at],
  )
  return rows[0] || null
}

function scanOnce(ctx, document, claim, trigger) {
  const key = `${document.id}:${document.version}`
  if (inFlight.has(key)) return inFlight.get(key)
  const job = (async () => {
    if (await latestRunFor(ctx.db, document)) return { scanned: false }
    try {
      await extractDocument(ctx, document, claim, { trigger })
      return { scanned: true }
    } catch (err) {
      // The failed attempt is recorded as a FAILED run, so it is not retried
      // on every page load; the reviewer can re-scan by hand.
      logger.warn('auto extraction failed', { documentId: document.id, trigger, code: err.code, requestId: ctx.actor.requestId })
      return { scanned: true, errorCode: err.code || 'AI_PROVIDER_ERROR' }
    }
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}

/**
 * Called by the upload service after the upload has committed. Runs in the
 * background so the upload responds at once; never throws. The run is
 * recorded against the uploader and audited under the agent identity with
 * trigger UPLOAD. No access check: this is the system acting on a file the
 * uploader was already allowed to add.
 */
export function queueUploadScan(ctx, documentId) {
  if (!autoScanEnabled(ctx.ai) || !ctx.actor?.id) return
  setImmediate(async () => {
    try {
      const document = await ctx.db.findById('documents', documentId)
      if (!document || document.status === 'SUPERSEDED') return
      const claim = await ctx.db.findById('claims', document.claim_id)
      if (!claim) return
      await scanOnce(ctx, document, claim, 'UPLOAD')
    } catch (err) {
      logger.warn('upload scan could not start', { documentId, code: err.code, message: err.message, requestId: ctx.actor.requestId })
    }
  })
}

/**
 * First-view fallback for the Automation tab and the Document Review dialog:
 * scans the document if its current version has no run yet (or waits for a
 * scan already in progress), then returns the latest run.
 */
export async function ensureDocumentExtraction(ctx, documentId) {
  requirePermission(ctx.actor, 'automation.extract')
  const document = await ctx.db.findById('documents', documentId)
  if (!document) throw notFound('Document not found')
  const claim = await loadAutomationClaim(ctx.db, ctx, document.claim_id)
  requireNotOwnClaim(ctx.actor, claim)

  const enabled = autoScanEnabled(ctx.ai) && document.status !== 'SUPERSEDED'
  const outcome = enabled ? await scanOnce(ctx, document, claim, 'FIRST_VIEW') : { scanned: false }
  const latest = await latestRunFor(ctx.db, document)
  const names = latest ? await profileMap(ctx.db, [latest.requested_by, latest.decided_by]) : {}
  return { enabled, scanned: outcome.scanned, errorCode: outcome.errorCode || null, run: latest ? presentRun(latest, names) : null }
}
