#!/usr/bin/env node
/**
 * Database commands for the PostgreSQL server in DATABASE_URL.
 *
 *   npm run db:migrate      apply pending migrations from database/migrations
 *   npm run db:status       list applied and pending migrations
 *   npm run db:seed-demo    load the fictional demo users, policies and claims
 *                           (development only; refuses NODE_ENV=production)
 */
import { loadConfig } from '../src/config/env.js'
import { createPgExecutor } from '../src/db/pgExecutor.js'
import { migrate, migrationFiles } from '../src/db/migrate.js'
import { createDependencies } from '../src/services/container.js'
import { DEMO_USERS } from '../src/seed/demoData.js'

async function main() {
  const command = process.argv[2]
  if (!['migrate', 'status', 'seed-demo'].includes(command)) {
    throw new Error('Usage: node scripts/db.js migrate | status | seed-demo')
  }

  if (command === 'seed-demo') {
    const config = loadConfig({ SEED_DEMO_DATA: 'true' })
    const deps = await createDependencies(config, { seed: true })
    await deps.db.close()
    console.log(`Demo data ready. Accounts (password ${config.DEMO_PASSWORD === 'HarborDemo!2026' ? 'HarborDemo!2026' : 'from DEMO_PASSWORD'}):`)
    for (const u of DEMO_USERS) console.log(`  ${u.roles.join(' + ').padEnd(22)} ${u.email}`)
    return
  }

  const config = loadConfig({ DB_MIGRATE_ON_START: 'false' })
  const executor = createPgExecutor({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 2 })
  try {
    if (command === 'migrate') {
      const applied = await migrate(executor, { log: (m) => console.log(`• ${m}`) })
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.')
    } else {
      const { rows } = await executor
        .query('select name, applied_at from app_meta.schema_migrations order by name')
        .catch(() => ({ rows: [] }))
      const done = new Map(rows.map((r) => [r.name, r.applied_at]))
      for (const name of migrationFiles()) {
        console.log(`${done.has(name) ? 'applied ' : 'PENDING '} ${name}${done.has(name) ? `  (${new Date(done.get(name)).toISOString()})` : ''}`)
      }
    }
  } finally {
    await executor.close()
  }
}

main().catch((err) => {
  console.error(`Database command failed: ${err.message}`)
  process.exit(1)
})
