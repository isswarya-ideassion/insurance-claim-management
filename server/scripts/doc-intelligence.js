#!/usr/bin/env node
/**
 * Document intelligence for the Document Reviewer queue.
 *
 *   node scripts/doc-intelligence.js train      fit the doc_type classifier on our labels
 *   node scripts/doc-intelligence.js analyse    run every document through the pipeline
 */
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { MIN_TRAINING_DOCS, analyseDocument, trainDocumentClassifier } from '../src/services/intelligence/documentIntelligence.service.js'

async function main() {
  const command = process.argv[2] || 'analyse'
  if (!['train', 'analyse'].includes(command)) throw new Error('Usage: node scripts/doc-intelligence.js train | analyse')

  const deps = await createDependencies(loadConfig({ DB_MIGRATE_ON_START: 'false', OVERDUE_SWEEP_MINUTES: '0' }))
  try {
    if (command === 'train') {
      try {
        const saved = await trainDocumentClassifier(deps.db)
        const m = saved.metrics
        console.log(`\nTrained on ${saved.trained_on} labelled documents -> v${saved.version}`)
        console.log(`Cross-validated accuracy: ${(m.accuracy * 100).toFixed(1)}%  (${m.scored} scored, ${m.skipped} skipped)`)
        console.log(`Classes: ${m.classes}   vocabulary: ${m.vocabulary} tokens`)
        if (m.withoutTextLayer) console.log(`${m.withoutTextLayer} document(s) had no text layer and need OCR.`)
        console.log()
      } catch (err) {
        if (err.code !== 'INSUFFICIENT_TRAINING_DATA') throw err
        console.log(`\n${err.message}`)
        console.log(`Have ${err.samples} / ${MIN_TRAINING_DOCS} required.\n`)
      }
      return
    }

    const docs = await deps.db.query('select id from public.documents order by created_at limit 40')
    let readable = 0
    let needsOcr = 0
    const samples = []
    for (const { id } of docs) {
      const out = await analyseDocument(deps.db, id)
      if (!out) continue
      if (out.needsOcr) {
        needsOcr += 1
        continue
      }
      readable += 1
      if (samples.length < 5) samples.push(out)
    }

    console.log(`\n${readable} document(s) have a readable text layer; ${needsOcr} need OCR.\n`)
    for (const s of samples) {
      console.log(`${s.fileName}  (recorded as ${s.currentType})`)
      if (s.suggestedType) {
        console.log(`   suggested type : ${s.suggestedType} ${(s.typeConfidence * 100).toFixed(0)}%${s.typeIsSuggestionOnly ? ' (hint only)' : ''}`)
      }
      for (const i of s.identifiers.slice(0, 4)) console.log(`   ${i.label.padEnd(22)} ${i.value}`)
      for (const p of s.proposals) console.log(`   proposes ${p.key.padEnd(14)} ${p.value}`)
      if (s.aadhaarPresent) console.log('   ! contains an Aadhaar-shaped number (masked, never extracted)')
      console.log()
    }
  } finally {
    await deps.db.close()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
