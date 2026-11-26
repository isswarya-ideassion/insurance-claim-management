import { createRepository } from './repository.js'
import { createPgExecutor } from './pgExecutor.js'
import { migrate, pendingMigrations } from './migrate.js'
import { logger } from '../config/logger.js'

/** Creates the data layer: a node-postgres pool on DATABASE_URL, migrated on start unless disabled. */
export async function createDatabase(config, { log = () => {} } = {}) {
  const executor = createPgExecutor({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    max: config.DATABASE_POOL_MAX,
  })
  if (config.DB_MIGRATE_ON_START) await migrate(executor, { log })
  else await warnIfMigrationsPending(executor)
  const db = createRepository(executor)
  db.kind = executor.kind
  db.close = executor.close
  db.executor = executor
  return db
}

/**
 * Serverless instances do not migrate (see serverless.js). Report, never apply,
 * so a missed `npm run db:migrate` shows up in the logs instead of as 500s.
 */
async function warnIfMigrationsPending(executor) {
  try {
    const pending = await pendingMigrations(executor)
    if (pending.length) {
      logger.warn(`${pending.length} database migration(s) not applied: ${pending.join(', ')}. Run npm run db:migrate against this DATABASE_URL.`)
    }
  } catch (err) {
    logger.warn(`could not check database migrations: ${err.message}`)
  }
}
