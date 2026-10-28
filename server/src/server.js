import { loadConfig } from './config/env.js'
import { logger } from './config/logger.js'
import { createDependencies } from './services/container.js'
import { createApp } from './app.js'
import { ensurePartitions, runScheduledJobs } from './jobs.js'
import { DEMO_DOMAIN } from './seed/demoData.js'

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
      runScheduledJobs(deps).catch((err) => logger.error('scheduled jobs failed', { error: err.message }))
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
