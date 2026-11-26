#!/usr/bin/env node
/**
 * Seeds the two E2E policyholders (Meera, Rohan) into the database in DATABASE_URL.
 * Idempotent: safe to run again, and re-runs add nothing that already exists.
 *
 *   npm run db:seed-e2e                              local database (server/.env)
 *   npm run db:seed-e2e -- --allow-production        a remote database (for example Vercel's)
 *   npm run db:seed-e2e -- --receipt <path.png>      forged bill file (default: demo-assets/...)
 *
 * Against a remote database every value below must be set in the environment
 * of this command, not only in server/.env, so nothing falls back to local
 * settings by accident:
 *   DATABASE_URL       the production connection string
 *   FIELD_ENCRYPTION_KEY  the SAME key the Vercel app uses (bank details are encrypted with it)
 *   DEMO_PASSWORD      the password the E2E accounts will get (no default is used remotely)
 *
 * This command never sets SEED_DEMO_DATA, so the production guard in env.js stays in force.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const DEFAULT_RECEIPT = path.join(ROOT, 'demo-assets', 'flow-2-fraud-and-wrong-proof', 'forged-tampered-invoice.png')

const args = process.argv.slice(2)
const allowRemote = args.includes('--allow-production')
const receiptIndex = args.indexOf('--receipt')
const receiptPath = receiptIndex >= 0 ? path.resolve(args[receiptIndex + 1] || '') : DEFAULT_RECEIPT

// Values set on the command itself. dotenv never overrides these, and remote runs must not rely on server/.env.
const inline = { ...process.env }
dotenv.config({ path: path.join(ROOT, 'server/.env'), quiet: true })

async function main() {
  const { loadConfig } = await import('../src/config/env.js')
  const { createDependencies } = await import('../src/services/container.js')
  const { assertSeedTarget, seedE2eDemo } = await import('../src/seed/e2eDemo.js')
  const { pendingMigrations } = await import('../src/db/migrate.js')

  const databaseUrl = process.env.DATABASE_URL || ''
  let host = ''
  let dbName = ''
  try {
    const u = new URL(databaseUrl)
    host = u.hostname
    dbName = u.pathname.replace(/^\//, '')
  } catch {
    throw new Error('DATABASE_URL is missing or not a valid connection string.')
  }
  const { local } = assertSeedTarget({ host, allowRemote })

  if (!local) {
    const missing = ['DATABASE_URL', 'FIELD_ENCRYPTION_KEY', 'DEMO_PASSWORD'].filter((k) => !inline[k])
    if (missing.length) {
      throw new Error(`Remote seeding needs ${missing.join(', ')} set on this command (not only in server/.env).`)
    }
  }

  if (!existsSync(receiptPath)) {
    throw new Error(`Receipt file not found: ${receiptPath}. Run node server/scripts/generate-e2e-assets.js first, or pass --receipt <path>.`)
  }
  const receipt = readFileSync(receiptPath)

  console.log(`Seeding E2E demo accounts into ${local ? 'the local' : 'a REMOTE'} database "${dbName}" on ${host}.`)
  const config = loadConfig({ DB_MIGRATE_ON_START: 'false', DATABASE_POOL_MAX: '2', SEED_DEMO_DATA: 'false' })
  const deps = await createDependencies(config, { seed: false })
  try {
    const pending = await pendingMigrations(deps.db.executor)
    if (pending.length) {
      throw new Error(`Database has ${pending.length} pending migration(s): ${pending.join(', ')}. Run npm run db:migrate against this database first.`)
    }
    const result = await seedE2eDemo(deps, { receipt })
    for (const line of result.log) console.log(`  • ${line}`)
    console.log(result.log.length ? `Seeded ${result.log.length} change(s).` : 'Already present: nothing changed.')
    if (result.olderClaimNumber) console.log(`Rohan's earlier claim: ${result.olderClaimNumber}`)
  } finally {
    await deps.db.close()
  }
}

main().catch((err) => {
  console.error(`E2E seed failed: ${err.message}`)
  process.exit(1)
})
