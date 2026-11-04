#!/usr/bin/env node
/**
 * Claim-anomaly model trained on our own claim history.
 *
 *   node scripts/anomaly-model.js train     fit a new version and activate it
 *   node scripts/anomaly-model.js score     rescore the whole book
 *   node scripts/anomaly-model.js top       show the highest-scoring claims
 */
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { MIN_TRAINING_ROWS, loadActiveModel, scoreAllClaims, trainClaimAnomalyModel } from '../src/services/intelligence/model.service.js'

const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

async function main() {
  const command = process.argv[2] || 'top'
  if (!['train', 'score', 'top'].includes(command)) throw new Error('Usage: node scripts/anomaly-model.js train | score | top')

  const deps = await createDependencies(loadConfig({ DB_MIGRATE_ON_START: 'false', OVERDUE_SWEEP_MINUTES: '0' }))
  try {
    if (command === 'train') {
      try {
        const saved = await trainClaimAnomalyModel(deps.db)
        console.log(`\nTrained ${saved.trained_on} claims -> model v${saved.version}`)
        console.log(`Score distribution: ${JSON.stringify(saved.metrics)}\n`)
      } catch (err) {
        if (err.code !== 'INSUFFICIENT_TRAINING_DATA') throw err
        console.log(`\n${err.message}`)
        console.log(`Book size: ${err.rows} / ${MIN_TRAINING_ROWS} required.\n`)
        return
      }
    }

    if (command === 'score') {
      const { scored, modelVersion } = await scoreAllClaims(deps.db)
      console.log(modelVersion ? `\nScored ${scored} claims with model v${modelVersion}.\n` : '\nNo active model. Train one first.\n')
    }

    const model = await loadActiveModel(deps.db)
    if (!model) {
      console.log('No active model.\n')
      return
    }
    const rows = await deps.db.query(
      `select c.claim_number, c.claim_type, c.estimated_loss, s.score, s.band, s.top_factors
         from public.claim_anomaly_scores s join public.claims c on c.id = s.claim_id
        order by s.score desc limit 10`,
    )
    console.log(`\nActive model v${model.version}, trained on ${model.trainedOn} claims\n`)
    for (const r of rows) {
      console.log(`${r.claim_number}  ${String(r.claim_type).padEnd(9)} ${inr(r.estimated_loss).padStart(14)}  ${Number(r.score).toFixed(3)} ${r.band}`)
      for (const f of (r.top_factors || []).slice(0, 3)) console.log(`     ${f.feature} (+${f.impact})`)
    }
    console.log()
  } finally {
    await deps.db.close()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
