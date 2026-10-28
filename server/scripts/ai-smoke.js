#!/usr/bin/env node
/**
 * End-to-end check of the configured AI provider against the demo data:
 * signs in as a demo user and runs one claim agent through the real API.
 * It creates an AI run awaiting review; nothing is applied to the claim.
 *
 *   node scripts/ai-smoke.js [agent] [claimNumber] [user]
 *   node scripts/ai-smoke.js coverage-checker HPC-2026-000102 ops.olivia
 */
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { createApp } from '../src/app.js'
import { DEMO_DOMAIN } from '../src/seed/demoData.js'

const [agent = 'coverage-checker', claimNumber = 'HPC-2026-000102', who = 'ops.olivia'] = process.argv.slice(2)

async function main() {
  const config = loadConfig({ DB_MIGRATE_ON_START: 'false', OVERDUE_SWEEP_MINUTES: '0' })
  if (config.isProduction) throw new Error('Run this check against a development database only')
  const deps = await createDependencies(config)
  const server = createApp(deps).listen(0)
  const base = `http://127.0.0.1:${server.address().port}/api/v1`
  try {
    console.log(`Provider: ${deps.ai.name} · model: ${deps.ai.model}`)
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${who}@${DEMO_DOMAIN}`, password: config.DEMO_PASSWORD }),
    }).then((r) => r.json())
    const token = login.data?.accessToken
    if (!token) throw new Error(`Sign-in failed for ${who}: ${login.error?.message}`)
    const auth = { authorization: `Bearer ${token}` }
    const [claim] = await deps.db.query('select id, status from public.claims where claim_number = $1', [claimNumber])
    if (!claim) throw new Error(`Claim ${claimNumber} not found`)
    console.log(`Running ${agent} on ${claimNumber} (${claim.status}) as ${who}…`)
    const started = Date.now()
    const res = await fetch(`${base}/claims/${claim.id}/agents/${agent}`, { method: 'POST', headers: auth })
    const body = await res.json()
    console.log(`HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    if (!res.ok) {
      console.log(JSON.stringify(body.error, null, 2))
      process.exitCode = 1
      return
    }
    const run = body.data.run
    console.log(`Run ${run.id} · confidence ${run.confidence} · ${run.review_status}`)
    console.log(JSON.stringify(run.result, null, 2))
  } finally {
    server.close()
    await deps.db.close()
  }
}

main().catch((err) => {
  console.error(`AI check failed: ${err.message}`)
  process.exit(1)
})
