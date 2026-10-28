#!/usr/bin/env node
// Lint step: verifies every relative and aliased import in src/ resolves to a
// file, and that no .jsx or TypeScript sources exist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const aliases = { '@/': src + path.sep, '@shared/': path.resolve(root, '../shared') + path.sep }

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const files = walk(src)
const problems = []
for (const f of files) {
  if (/\.(jsx|tsx?|mts|cts)$/.test(f)) problems.push(`${path.relative(root, f)}: only .js sources are allowed`)
}

const importRe = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
for (const file of files.filter((f) => f.endsWith('.js'))) {
  const code = readFileSync(file, 'utf8')
  for (const m of code.matchAll(importRe)) {
    const spec = m[1] || m[2] || m[3]
    let target = null
    if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec)
    for (const [prefix, dir] of Object.entries(aliases)) if (spec.startsWith(prefix)) target = dir + spec.slice(prefix.length)
    if (target && !existsSync(target)) problems.push(`${path.relative(root, file)}: cannot resolve "${spec}"`)
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`✓ ${files.length} files checked, all imports resolve`)
