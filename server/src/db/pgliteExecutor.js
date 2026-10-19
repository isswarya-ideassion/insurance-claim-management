import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
export const MIGRATIONS_DIR = path.join(repoRoot, 'supabase', 'migrations')
export const SEED_SQL = path.join(repoRoot, 'supabase', 'seed.sql')
const STUBS_SQL = path.join(here, 'supabase-stubs.sql')

/**
 * Embedded Postgres (PGlite) used by MOCK MODE and the test suite. It runs the
 * real Supabase migrations on top of minimal stand-ins for Supabase's auth and
 * storage schemas, so triggers, constraints and RLS behave as in production.
 */
export async function createPgliteExecutor({ dataDir = null } = {}) {
  if (dataDir) mkdirSync(dataDir, { recursive: true })
  const db = new PGlite({
    dataDir: dataDir || undefined,
    extensions: { pgcrypto },
    parsers: {
      1700: (v) => (v === null ? null : Number(v)),
      1082: (v) => v,
      20: (v) => (v === null ? null : Number(v)),
    },
  })
  await db.waitReady
  await applyMigrations(db)

  return {
    kind: 'pglite',
    raw: db,
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) })),
    close: () => db.close(),
  }
}

async function applyMigrations(db) {
  await db.exec(`create schema if not exists local_meta;
    create table if not exists local_meta.applied_migrations (name text primary key, applied_at timestamptz default now());`)
  const applied = new Set((await db.query('select name from local_meta.applied_migrations')).rows.map((r) => r.name))

  const files = [
    { name: '00000000000000_supabase_stubs.sql', file: STUBS_SQL },
    ...readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ name: f, file: path.join(MIGRATIONS_DIR, f) })),
    { name: 'zz_seed_reference_data.sql', file: SEED_SQL, always: true },
  ]

  for (const { name, file, always } of files) {
    if (applied.has(name) && !always) continue
    const sql = readFileSync(file, 'utf8')
    try {
      await db.exec(sql)
    } catch (err) {
      throw new Error(`Failed to apply ${name}: ${err.message}`)
    }
    await db.query('insert into local_meta.applied_migrations (name) values ($1) on conflict do nothing', [name])
  }
}
