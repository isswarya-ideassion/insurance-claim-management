import { logger } from './config/logger.js'
import { runOverdueSweep } from './modules/tasks/tasks.service.js'
import { runDeadlineReminderSweep } from './modules/automation/reminders.service.js'
import { runSlaSweep } from './services/sla.service.js'

/** Keeps monthly audit and AI-run partitions three months ahead (rows never land in the default partition). */
export async function ensurePartitions(deps) {
  for (const table of ['audit_logs', 'ai_runs']) {
    await deps.db.query('select public.create_monthly_partitions($1, current_date, 3)', [table])
  }
}

const JOBS = {
  overdueTasks: runOverdueSweep,
  deadlineReminders: runDeadlineReminderSweep,
  slaEscalation: runSlaSweep,
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
