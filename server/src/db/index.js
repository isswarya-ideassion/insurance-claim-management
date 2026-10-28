import { createRepository } from './repository.js'

/**
 * Creates the data layer for the configured mode.
 *   supabase -> node-postgres pool against the Supabase database
 *   mock     -> embedded PGlite running the same migrations (local demo / tests)
 */
export async function createDatabase(config) {
  let executor
  if (config.DATA_MODE === 'supabase') {
    const { createPgExecutor } = await import('./pgExecutor.js')
    executor = createPgExecutor({ connectionString: config.SUPABASE_DB_URL, ssl: config.SUPABASE_DB_SSL })
  } else {
    const { createPgliteExecutor } = await import('./pgliteExecutor.js')
    executor = await createPgliteExecutor({ dataDir: config.mock.dbDir })
  }
  const db = createRepository(executor)
  db.kind = executor.kind
  db.close = executor.close
  db.executor = executor
  return db
}
