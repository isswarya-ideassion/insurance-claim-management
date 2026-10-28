#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY provisioning for a Supabase project.
 *
 * Creates one demo account per role through the Supabase Auth Admin API
 * (never by inserting into profiles directly), then loads fictional demo
 * policies, claims and related records linked to those real auth users, and
 * uploads placeholder PDFs to the private storage bucket.
 *
 * Usage:  DATA_MODE=supabase DEV_SEED_PASSWORD='...' npm run provision:dev
 * Refuses to run when NODE_ENV=production or without --yes for non-local URLs.
 */
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { seedDemoData, demoDataExists, DEMO_USERS } from '../src/seed/demoData.js'
import { passwordSchema } from '../src/modules/auth/auth.validators.js'

async function main() {
  const config = loadConfig()
  if (config.isProduction) throw new Error('Refusing to provision demo data with NODE_ENV=production.')
  if (config.DATA_MODE !== 'supabase') {
    throw new Error('Set DATA_MODE=supabase. Mock mode seeds itself automatically on first start.')
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(config.SUPABASE_URL)
  if (!isLocal && !process.argv.includes('--yes')) {
    throw new Error(`SUPABASE_URL (${config.SUPABASE_URL}) is not local. Re-run with --yes to confirm this is a development project.`)
  }
  const password = process.env.DEV_SEED_PASSWORD
  const check = passwordSchema.safeParse(password || '')
  if (!check.success) {
    throw new Error(`DEV_SEED_PASSWORD must be set and strong: ${check.error.issues.map((i) => i.message).join('; ')}`)
  }

  const deps = await createDependencies(config, { seed: false })
  try {
    if (await demoDataExists(deps.db) && (await deps.db.count('claims', {})) > 0) {
      console.log('Demo data already present — nothing to do.')
      return
    }
    const result = await seedDemoData({
      db: deps.db,
      storage: deps.storage,
      password,
      createUser: async (u) => {
        try {
          return await deps.authProvider.createUser(u)
        } catch (err) {
          if (err.code !== 'USER_EXISTS') throw err
          const { data } = await deps.authProvider.admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
          const found = data.users.find((x) => x.email?.toLowerCase() === u.email.toLowerCase())
          if (!found) throw err
          return { id: found.id }
        }
      },
      log: (msg) => console.log(`• ${msg}`),
    })
    console.log(`\nProvisioned ${result.users} accounts, ${result.policies} policies and ${result.claims} claims.`)
    console.log('Accounts (password from DEV_SEED_PASSWORD):')
    for (const u of DEMO_USERS) console.log(`  ${u.roles.join(' + ').padEnd(40)} ${u.email}`)
  } finally {
    await deps.db.close?.()
  }
}

main().catch((err) => {
  console.error(`Provisioning failed: ${err.message}`)
  process.exit(1)
})
