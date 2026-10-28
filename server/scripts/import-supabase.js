#!/usr/bin/env node
/**
 * One-time move from a Supabase project to a plain PostgreSQL database.
 *
 * Copies auth.users (email, password hash, metadata), every application table
 * and the claim-number sequence from the Supabase database, applies any
 * migrations the Supabase project had not run yet (so an un-upgraded project
 * also receives the PRD schema), and downloads every stored claim document from
 * Supabase Storage into public.document_files. Users keep their passwords:
 * Supabase's bcrypt hashes are accepted and re-hashed at the next sign-in.
 *
 * Usage (from server/):
 *   SUPABASE_DB_URL=postgresql://postgres.<ref>:<pw>@<pooler-host>:5432/postgres \
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> \
 *   DATABASE_URL=postgresql://<user>:<pw>@<host>:5432/harborpoint \
 *   npm run db:import-supabase -- --yes
 *
 * Optional: SUPABASE_DB_SSL=require|verify-full|disable (default require),
 * SUPABASE_STORAGE_BUCKET (default claim-documents), --skip-files.
 *
 * The target must be empty (a freshly created database). The connecting user
 * needs permission to SET session_replication_role (a superuser, or
 * rds_superuser / cloudsqlsuperuser on managed services) so that triggers and
 * foreign keys are suspended while the copied rows are written. The Supabase
 * project is only read, never changed.
 */
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPgExecutor } from '../src/db/pgExecutor.js'
import { MIGRATIONS_DIR, migrate, migrationFiles } from '../src/db/migrate.js'
import { createFieldCrypto, encryptLegacyFields } from '../src/services/crypto.service.js'
import { createRepository } from '../src/db/repository.js'

const BATCH = 500
const AUTH_COLUMNS = ['id', 'email', 'encrypted_password', 'raw_user_meta_data', 'raw_app_meta_data', 'email_confirmed_at', 'created_at']
const MIME_BY_EXT = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

const env = (name, fallback) => {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}
const qi = (name) => `"${name.replace(/"/g, '""')}"`
const log = (msg) => console.log(`• ${msg}`)

async function sourceMigrationLevel(source) {
  const { rows } = await source.query(`select to_regclass('supabase_migrations.schema_migrations') as t`)
  if (!rows[0].t) return null
  const versions = (await source.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => String(r.version))
  return new Set(versions)
}

/** Base tables (and partitioned parents) of a schema, with their columns and types. */
async function tableColumns(db, schema) {
  const { rows } = await db.query(
    `select c.relname as table_name, a.attname as column_name, format_type(a.atttypid, a.atttypmod) as type, a.attnum,
            a.attgenerated <> '' as generated
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = $1 and c.relkind in ('r', 'p') and not c.relispartition
      order by c.relname, a.attnum`,
    [schema],
  )
  const tables = new Map()
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, [])
    if (!r.generated) tables.get(r.table_name).push({ name: r.column_name, type: r.type })
  }
  return tables
}

/**
 * Copies rows as text and casts them back with the target's column types, so
 * every value (numeric, jsonb, arrays, bytea, timestamps) round-trips exactly.
 * Rows are read through a cursor, which also works for partitioned tables.
 */
async function copyTable(source, target, { fromSchema, toSchema, table, columns }) {
  if (!columns.length) return 0
  const selectList = columns.map((c) => `${qi(c.name)}::text`).join(', ')
  const insertCols = columns.map((c) => qi(c.name)).join(', ')
  // PostgreSQL accepts at most 65535 bind parameters per statement.
  const batch = Math.max(1, Math.min(BATCH, Math.floor(60000 / columns.length)))
  let copied = 0
  await source.transaction(async (s) => {
    await s.query(`declare import_cursor no scroll cursor for select ${selectList} from ${qi(fromSchema)}.${qi(table)}`)
    for (;;) {
      const { rows } = await s.query(`fetch ${batch} from import_cursor`)
      if (!rows.length) break
      const params = []
      const tuples = rows.map((row) => {
        const slots = columns.map((c) => {
          params.push(row[c.name])
          return `$${params.length}::${c.type}`
        })
        return `(${slots.join(', ')})`
      })
      await target.query(`insert into ${qi(toSchema)}.${qi(table)} (${insertCols}) values ${tuples.join(', ')}`, params)
      copied += rows.length
    }
    await s.query('close import_cursor')
  })
  return copied
}

async function downloadFile({ url, key, bucket, path: objectPath }) {
  const res = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const sourceUrl = env('SUPABASE_DB_URL')
  const targetUrl = env('DATABASE_URL')
  if (!sourceUrl || !targetUrl) throw new Error('Set SUPABASE_DB_URL (source) and DATABASE_URL (target).')
  if (sourceUrl === targetUrl) throw new Error('SUPABASE_DB_URL and DATABASE_URL point at the same database.')
  const skipFiles = args.has('--skip-files')
  const storageUrl = env('SUPABASE_URL', '').replace(/\/+$/, '')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  const bucket = env('SUPABASE_STORAGE_BUCKET', 'claim-documents')
  if (!skipFiles && (!storageUrl || !serviceKey)) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to copy stored documents, or pass --skip-files.')
  }
  if (!args.has('--yes')) {
    throw new Error(`This copies all data from ${new URL(sourceUrl).host} into ${new URL(targetUrl).host}${new URL(targetUrl).pathname}. Re-run with --yes to confirm.`)
  }

  const source = createPgExecutor({ connectionString: sourceUrl, ssl: env('SUPABASE_DB_SSL', 'require'), max: 2 })
  const target = createPgExecutor({ connectionString: targetUrl, ssl: env('DATABASE_SSL', 'disable'), max: 2 })
  try {
    // 1. The target must be empty, so nothing already there is overwritten.
    const existing = await target.query(
      `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'app_meta') and c.relkind in ('r', 'p')`,
    )
    if (existing.rows[0].n > 0) throw new Error('The target database is not empty. Create a new, empty database for the import.')

    // Encrypted fields only stay readable with the key the Supabase deployment used.
    const sample = (await source.query(
      `select bank_details_encrypted as v from public.payees where bank_details_encrypted like 'v1:%' limit 1`,
    ).catch(() => ({ rows: [] }))).rows[0]
    if (sample) {
      const keyValue = env('FIELD_ENCRYPTION_KEY')
      if (!keyValue) throw new Error('The source holds encrypted bank details: set FIELD_ENCRYPTION_KEY to the key the Supabase deployment used.')
      try {
        createFieldCrypto(/^[0-9a-f]{64}$/i.test(keyValue) ? Buffer.from(keyValue, 'hex') : Buffer.from(keyValue, 'base64')).decrypt(sample.v)
      } catch {
        throw new Error('FIELD_ENCRYPTION_KEY cannot decrypt the source data. Use the exact key the Supabase deployment used.')
      }
      log('FIELD_ENCRYPTION_KEY decrypts the source data')
    }

    // 2. Rebuild the source's schema version on the target. The Supabase CLI ledger says
    //    which migrations ran; without it, the presence of public.users tells MVP from PRD schema.
    const files = migrationFiles()
    const version = (f) => f.split('_')[0]
    const BOOTSTRAP = '20261019000000'
    const POSTGRES_ONLY = ['20261023000009'] // migrations written after leaving Supabase
    const sourceLevel = await sourceMigrationLevel(source)
    let atSource
    if (sourceLevel) {
      atSource = files.filter((f) => version(f) === BOOTSTRAP || sourceLevel.has(version(f)))
    } else {
      const prdSchema = (await source.query(`select to_regclass('public.users') as t`)).rows[0].t
      log(`no Supabase migration ledger found; detected the ${prdSchema ? 'PRD' : 'MVP'} schema`)
      const notYet = prdSchema ? POSTGRES_ONLY : ['20261022000007', '20261022000008', ...POSTGRES_ONLY]
      atSource = files.filter((f) => !notYet.includes(version(f)))
    }
    log(`source schema: ${atSource.length - 1} of ${files.length - 1} migrations applied`)

    await target.query(`create schema if not exists app_meta;
      create table if not exists app_meta.schema_migrations (name text primary key, applied_at timestamptz not null default now())`)
    for (const name of atSource) {
      await target.transaction(async (t) => {
        await t.query(readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'))
        await t.query('insert into app_meta.schema_migrations (name) values ($1)', [name])
      })
    }

    // 3. Copy credentials and data with triggers and foreign keys suspended.
    const [sourcePublic, targetPublic] = await Promise.all([tableColumns(source, 'public'), tableColumns(target, 'public')])
    const counts = []
    await target.transaction(async (t) => {
      await t.query('set local session_replication_role = replica')
      const targetTables = [...targetPublic.keys()]
      if (targetTables.length) await t.query(`truncate ${targetTables.map((n) => `public.${qi(n)}`).join(', ')} cascade`)

      const authCount = await copyTable(source, t, {
        fromSchema: 'auth',
        toSchema: 'auth',
        table: 'users',
        columns: AUTH_COLUMNS.map((name) => ({ name, type: { id: 'uuid', raw_user_meta_data: 'jsonb', raw_app_meta_data: 'jsonb', email_confirmed_at: 'timestamptz', created_at: 'timestamptz' }[name] || 'text' })),
      })
      counts.push(['auth.users', authCount])

      for (const [table, cols] of targetPublic) {
        const fromCols = sourcePublic.get(table)
        if (!fromCols) continue
        const shared = cols.filter((c) => fromCols.some((s) => s.name === c.name))
        const n = await copyTable(source, t, { fromSchema: 'public', toSchema: 'public', table, columns: shared })
        counts.push([`public.${table}`, n])
      }
      const skipped = [...sourcePublic.keys()].filter((n) => !targetPublic.has(n))
      if (skipped.length) log(`not copied (no matching table in the migrations): ${skipped.join(', ')}`)

      const { rows: seqs } = await source.query(
        `select sequencename as name, last_value from pg_sequences where schemaname = 'public' and last_value is not null`,
      )
      for (const s of seqs) await t.query('select setval($1, $2)', [`public.${s.name}`, s.last_value]).catch(() => {})
    })
    for (const [name, n] of counts) log(`${name}: ${n} row(s)`)

    // 4. Apply what the Supabase project had not run yet (for an MVP project: the PRD conversion).
    const remaining = await migrate(target, { log: (m) => log(m) })
    if (!remaining.length) log('schema already current')

    // 5. Stored documents: Supabase Storage → public.document_files.
    const db = createRepository(target)
    const keys = await db.query(
      `select distinct storage_key, mime_type from (
         select storage_key, mime_type from public.documents
         union all select storage_key, mime_type from public.document_versions) k
       where storage_key is not null and not exists (select 1 from public.document_files f where f.storage_key = k.storage_key)`,
    )
    const missing = []
    if (skipFiles) log(`skipped ${keys.length} stored document(s) (--skip-files)`)
    else {
      let stored = 0
      for (const k of keys) {
        try {
          const buffer = await downloadFile({ url: storageUrl, key: serviceKey, bucket, path: k.storage_key })
          const mime = k.mime_type || MIME_BY_EXT[k.storage_key.split('.').pop().toLowerCase()] || 'application/pdf'
          const sha = createHash('sha256').update(buffer).digest('hex')
          await db.query(
            `insert into public.document_files (storage_key, content, mime_type, size_bytes, sha256) values ($1, $2, $3, $4, $5)
             on conflict (storage_key) do nothing`,
            [k.storage_key, buffer, mime, buffer.length, sha],
          )
          stored++
        } catch (err) {
          missing.push(`${k.storage_key} (${err.message})`)
        }
      }
      log(`stored documents: ${stored} copied, ${missing.length} missing`)
      for (const m of missing.slice(0, 20)) console.log(`    missing: ${m}`)
    }

    // 6. Encrypt plain-text fields now when the key is available (otherwise the API does it at start).
    const keyValue = env('FIELD_ENCRYPTION_KEY')
    if (keyValue) {
      const key = /^[0-9a-f]{64}$/i.test(keyValue) ? Buffer.from(keyValue, 'hex') : Buffer.from(keyValue, 'base64')
      if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters).')
      await encryptLegacyFields(db, createFieldCrypto(key))
      log('sensitive fields encrypted')
    } else {
      log('FIELD_ENCRYPTION_KEY not set here: the API encrypts migrated bank details and contacts when it starts')
    }

    // 7. Verify.
    const chain = await db.query('select count(*)::int as problems from public.verify_audit_chain()')
    const noPassword = await db.query(`select count(*)::int as n from auth.users where coalesce(encrypted_password, '') = ''`)
    log(`audit hash chain: ${chain[0].problems === 0 ? 'intact' : `${chain[0].problems} problem(s)`}`)
    if (noPassword[0].n) log(`${noPassword[0].n} account(s) have no password (for example magic-link sign-ups); they must use "Forgot password"`)
    console.log(missing.length ? '\nImport finished with missing files (listed above).' : '\nImport finished.')
    if (missing.length) process.exitCode = 2
  } finally {
    await Promise.all([source.close(), target.close()])
  }
}

main().catch((err) => {
  console.error(`Import failed: ${err.message}`)
  process.exit(1)
})
