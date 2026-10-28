import { loadConfig } from './config/env.js'
import { logger } from './config/logger.js'
import { createDependencies } from './services/container.js'
import { createApp } from './app.js'
import { runOverdueSweep } from './modules/tasks/tasks.service.js'
import { runDeadlineReminderSweep } from './modules/automation/reminders.service.js'
import { runSlaSweep } from './services/sla.service.js'
import { DEMO_DOMAIN } from './seed/demoData.js'

/** Keeps monthly audit and AI-run partitions three months ahead (rows never land in the default partition). */
async function ensurePartitions(deps) {
  for (const table of ['audit_logs', 'ai_runs']) {
    await deps.db.query('select public.create_monthly_partitions($1, current_date, 3)', [table])
  }
}

async function main() {
  const config = loadConfig()
  const deps = await createDependencies(config)
  const app = createApp(deps)
  await ensurePartitions(deps)

  const server = app.listen(config.PORT, () => {
    logger.info(`HarborPoint Claims API listening on http://localhost:${config.PORT}/api/v1`, {
      env: config.NODE_ENV,
      demoData: config.demoData,
    })
    if (config.demoData) {
      console.log(
        [
          '',
          '  ┌──────────────────────────────────────────────────────────────────┐',
          '  │  DEMO DATA — fictional users, policies and claims; SIMULATED     │',
          '  │  payments. Never point SEED_DEMO_DATA=true at real data.         │',
          '  └──────────────────────────────────────────────────────────────────┘',
          `  Demo accounts: <role>.<name>@${DEMO_DOMAIN}  (see docs/SETUP.md)`,
          '',
        ].join('\n'),
      )
    }
  })

  let timer = null
  if (config.OVERDUE_SWEEP_MINUTES > 0) {
    timer = setInterval(() => {
      runOverdueSweep(deps).catch((err) => logger.error('overdue sweep failed', { error: err.message }))
      runDeadlineReminderSweep(deps).catch((err) => logger.error('reminder sweep failed', { error: err.message }))
      runSlaSweep(deps).catch((err) => logger.error('sla sweep failed', { error: err.message }))
      ensurePartitions(deps).catch((err) => logger.error('partition maintenance failed', { error: err.message }))
    }, config.OVERDUE_SWEEP_MINUTES * 60_000)
    timer.unref()
  }

  const shutdown = async (signal) => {
    logger.info(`received ${signal}, shutting down`)
    if (timer) clearInterval(timer)
    server.close(async () => {
      await deps.db.close?.()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error('failed to start server', { error: err.message })
  console.error(err.message)
  process.exit(1)
})
