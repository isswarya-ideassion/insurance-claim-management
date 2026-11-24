import { AUTOPILOT_ACTIONS, humanize } from '../../../../shared/constants.js'
import { logger } from '../../config/logger.js'

/** The auto-pilot's actions on one claim, for the attribution badges in the claim workspace. */
export async function autopilotActionsForClaim(db, claimId) {
  const rows = await db.findMany('autopilot_actions', { where: { claim_id: claimId }, orderBy: [['created_at', 'desc']], limit: 25 })
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    stage: r.stage,
    action: r.action,
    label: AUTOPILOT_ACTIONS[r.action]?.label || humanize(r.action),
    outcome: r.outcome,
    reason_code: r.reason_code,
    reason: r.reason,
    document_id: r.document_id,
  }))
}

/**
 * Lifecycle trigger for Beacon AI Auto-Pilot (claim submitted, document
 * uploaded, status changed): a one-claim sweep in the background once the
 * request has committed. Only with AI_AUTOPILOT_ENABLED=true and the Beacon
 * provider; the sweep itself also checks the on/off toggle. Never throws, and
 * the auto-pilot's own actions never re-trigger it.
 *
 * Kept apart from autopilot.service.js and loaded lazily: that service calls
 * the claims, documents and assignments services, which call this hook.
 */
export function queueAutopilotForClaim(ctx, claimId, event) {
  if (!ctx?.config?.AI_AUTOPILOT_ENABLED || ctx.actor?.autopilot || !claimId) return
  if (!(ctx.ai?.configured && ctx.ai.name === 'beacon')) return
  setImmediate(async () => {
    try {
      const { runAutopilotSweep } = await import('./autopilot.service.js')
      await runAutopilotSweep(ctx, { trigger: `EVENT_${event}`, claimId, requestId: ctx.actor?.requestId })
    } catch (err) {
      logger.warn('autopilot lifecycle sweep failed', { claimId, event, error: err.message })
    }
  })
}
