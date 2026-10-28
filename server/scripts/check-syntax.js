#!/usr/bin/env node
// Lint step: parses every server source file and imports every module so that
// syntax errors, missing files and missing named exports fail fast.
import { readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.NODE_ENV = 'test'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs = ['src', 'scripts', 'tests', '../shared']

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : []
  })
}

const files = dirs.flatMap((d) => walk(path.join(root, d)))
let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    failed += 1
    console.error(`✗ syntax: ${path.relative(root, file)}\n${err.stderr?.toString()}`)
  }
}

const importable = files.filter(
  (f) => (f.includes(`${path.sep}src${path.sep}`) || f.includes(`${path.sep}shared${path.sep}`)) && !f.endsWith(`src${path.sep}server.js`),
)
for (const file of importable) {
  try {
    await import(pathToFileURL(file).href)
  } catch (err) {
    failed += 1
    console.error(`✗ import: ${path.relative(root, file)} — ${err.message}`)
  }
}

if (failed) {
  console.error(`\n${failed} problem(s) found`)
  process.exit(1)
}
console.log(`✓ ${files.length} files parsed, ${importable.length} modules imported`)
