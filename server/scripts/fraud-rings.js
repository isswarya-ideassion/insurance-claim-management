#!/usr/bin/env node
/**
 * Organised-fraud ring detection against the database in DATABASE_URL.
 *
 *   node scripts/fraud-rings.js detect          score every linked group of entities
 *   node scripts/fraud-rings.js demo            build the shared-address scenario, then detect
 *
 * "detect" is what the nightly job calls. "demo" plants two shell entities at
 * one co-working address with a failed site visit, so the pipeline can be seen
 * working end to end on real rows.
 */
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { normalizeAddress } from '../src/services/intelligence/addressNormalizer.js'
import { detectRings } from '../src/services/intelligence/fraudRing.service.js'

const SHELLS = [
  { name: 'Northwind Trading Solutions Pvt Ltd', address: 'Northwind Trading Solutions Pvt Ltd, Suite 1104, 11th Floor, Prestige Towers, M.G. Road, Bengaluru - 560 001' },
  { name: 'Marigold Exports Private Limited', address: 'Marigold Exports Private Limited, Unit 1210, Prestige Tower, MG Rd, Bangalore 560001' },
]

async function plantDemo(db, config) {
  // This command inserts fictional shell entities and failed site visits.
  // Against a real book that would manufacture a fraud ring out of nothing,
  // so it is refused in production exactly as the demo seeder is.
  if (config.isProduction) {
    throw new Error('"demo" plants fictional entities and cannot run with NODE_ENV=production. Use "detect".')
  }
  const customers = await db.query(
    `select id, full_name from public.users u
      where exists (select 1 from public.user_roles r where r.user_id = u.id and r.role_code = 'CLIENT')
      order by u.created_at limit 2`,
  )
  if (customers.length < 2) throw new Error('Need two CLIENT users. Run: npm run db:seed-demo')

  for (const [i, shell] of SHELLS.entries()) {
    const entity = customers[i]
    const norm = normalizeAddress(shell.address, { entityName: shell.name })
    const [premises] = await db.query(
      `insert into public.entity_premises
         (entity_id, address_role, raw_address, premises_hash, unit_label, pincode, city_normalized,
          workspace_provider, is_shared_workspace, created_by)
       values ($1, 'REGISTERED', $2, $3, $4, $5, $6, $7, $8, $1)
       returning id`,
      [entity.id, shell.address, norm.premisesHash, norm.unitLabel, norm.pincode, norm.city, norm.workspaceProvider, norm.isSharedWorkspace],
    )
    console.log(`  ${shell.name}`)
    console.log(`    entity   ${entity.full_name}`)
    console.log(`    unit     ${norm.unitLabel}`)
    console.log(`    building ${norm.premisesHash.slice(0, 16)}…`)

    // The inspector's visit: this is the fact that turns a shared address into evidence.
    await db.query(
      `insert into public.premises_verifications (entity_premises_id, outcome, visited_at, notes, verified_by)
       values ($1, $2, now(), $3, $4)`,
      [premises.id, i === 0 ? 'NOT_FOUND' : 'OCCUPANT_DENIES', 'Site visit: no office or signage at the suite', entity.id],
    )
  }
}

async function main() {
  const command = process.argv[2] || 'detect'
  if (!['detect', 'demo'].includes(command)) throw new Error('Usage: node scripts/fraud-rings.js detect | demo')

  const config = loadConfig({ DB_MIGRATE_ON_START: 'false', OVERDUE_SWEEP_MINUTES: '0' })
  const deps = await createDependencies(config)
  try {
    if (command === 'demo') {
      console.log('\nPlanting two shell entities at one co-working building:\n')
      await plantDemo(deps.db, config)
    }

    const { ringsEvaluated, ringsRecorded, rings } = await detectRings(deps.db)
    console.log(`\nLinked groups examined: ${ringsEvaluated}   recorded above threshold: ${ringsRecorded}\n`)
    for (const ring of rings) {
      console.log(`RING ${ring.key.slice(0, 12)}  score ${ring.score}/100  ${ring.band}  (${ring.entityIds.length} entities, ${ring.facts.claims.length} claims)`)
      for (const s of ring.signals) console.log(`   +${String(s.weight).padStart(2)}  ${s.code.padEnd(28)} ${s.detail}`)
      console.log()
    }
    if (!rings.length) console.log('No ring scored above the threshold.\n')
  } finally {
    await deps.db.close()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
