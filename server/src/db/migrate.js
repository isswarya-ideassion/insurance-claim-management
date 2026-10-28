import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
export const MIGRATIONS_DIR = path.join(repoRoot, 'database', 'migrations')
export const SEED_SQL = path.join(repoRoot, 'database', 'seed.sql')

// Any constant works; it only has to be the same for every API instance.
const MIGRATION_LOCK = 4_243_310_001

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Applies pending files from database/migrations in filename order, each in its
 * own transaction, then the reference seed (idempotent). Applied files are
 * recorded in app_meta.schema_migrations. An advisory lock lets several API
 * instances start at once without applying a migration twice.
 */
export async function migrate(executor, { log = () => {} } = {}) {
  await executor.transaction(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
    await t.query(`create schema if not exists app_meta;
      create table if not exists app_meta.schema_migrations (name text primary key, applied_at timestamptz not null default now())`)
  })

  const applied = []
  for (const name of migrationFiles()) {
    const done = await executor.transaction(async (t) => {
      await t.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
      const { rows } = await t.query('select 1 from app_meta.schema_migrations where name = $1', [name])
      if (rows.length) return false
      try {
        await t.query(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
      } catch (err) {
        throw new Error(`Failed to apply migration ${name}: ${err.message}`)
      }
      await t.query('insert into app_meta.schema_migrations (name) values ($1)', [name])
      return true
    })
    if (done) {
      applied.push(name)
      log(`applied ${name}`)
    }
  }

  await executor.transaction(async (t) => {
    await t.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
    await t.query(readFileSync(SEED_SQL, 'utf8'))
  })
  return applied
}
