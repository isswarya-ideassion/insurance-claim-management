import { logger } from './config/logger.js'
import { runOverdueSweep } from './modules/tasks/tasks.service.js'
import { runDeadlineReminderSweep } from './modules/automation/reminders.service.js'
import { runSlaSweep } from './services/sla.service.js'
import { detectRings } from './services/intelligence/fraudRing.service.js'
import { scoreAllClaims } from './services/intelligence/model.service.js'
import { runScheduledAutopilot } from './modules/automation/autopilot.service.js'

/** Keeps monthly audit and AI-run partitions three months ahead (rows never land in the default partition). */
export async function ensurePartitions(deps) {
  for (const table of ['audit_logs', 'ai_runs']) {
    await deps.db.query('select public.create_monthly_partitions($1, current_date, 3)', [table])
  }
}

/**
 * Ring detection and anomaly scoring run here rather than on the request path:
 * both read the whole book, which is far too much work to do while a user
 * waits. Scores are read from claim_anomaly_scores, written by this pass.
 */
const runRingDetection = (deps) => detectRings(deps.db)
/** No active model is the normal state until the book is large enough to train. */
const runAnomalyScoring = (deps) => scoreAllClaims(deps.db)

const JOBS = {
  overdueTasks: runOverdueSweep,
  deadlineReminders: runDeadlineReminderSweep,
  slaEscalation: runSlaSweep,
  fraudRings: runRingDetection,
  anomalyScoring: runAnomalyScoring,
  // After ring detection and scoring, so the fraud shield sees fresh rings and anomaly bands.
  // A no-op unless the auto-pilot is switched on and AI_PROVIDER=beacon.
  beaconAutopilot: runScheduledAutopilot,
  partitions: ensurePartitions,
}

/**
 * The scheduled jobs: run every OVERDUE_SWEEP_MINUTES by the long-running
 * server, or by an external scheduler (Vercel Cron) through the cron endpoint.
 * One failing job does not stop the others.
 */
export async function runScheduledJobs(deps) {
  const results = {}
  for (const [name, job] of Object.entries(JOBS)) {
    try {
      await job(deps)
      results[name] = 'ok'
    } catch (err) {
      results[name] = 'failed'
      logger.error('scheduled job failed', { job: name, error: err.message })
    }
  }
  return results
}
