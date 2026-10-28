import { createRepository } from './repository.js'
import { createPgExecutor } from './pgExecutor.js'
import { migrate } from './migrate.js'

/** Creates the data layer: a node-postgres pool on DATABASE_URL, migrated on start unless disabled. */
export async function createDatabase(config, { log = () => {} } = {}) {
  const executor = createPgExecutor({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    max: config.DATABASE_POOL_MAX,
  })
  if (config.DB_MIGRATE_ON_START) await migrate(executor, { log })
  const db = createRepository(executor)
  db.kind = executor.kind
  db.close = executor.close
  db.executor = executor
  return db
}
