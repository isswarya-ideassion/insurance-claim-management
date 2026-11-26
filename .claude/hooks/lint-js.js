#!/usr/bin/env node
// PostToolUse hook: after Claude edits a .js file, runs a fast check for that workspace.
//   server/ or shared/ -> `node --check <file>` (syntax of the edited file only)
//   client/ or shared/ -> client/scripts/check-imports.js (import resolution, .js-only rule)
// Full checks still run with `npm run lint`. On failure exits 2 so the output is shown to Claude.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let raw = ''
for await (const chunk of process.stdin) raw += chunk

let filePath = ''
try {
  filePath = JSON.parse(raw).tool_input?.file_path || ''
} catch {
  process.exit(0)
}
if (!filePath.endsWith('.js')) process.exit(0)

// Resolve the repo root from this script's location (CLAUDE_PROJECT_DIR may be a /c/... POSIX path on Windows).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const abs = path.resolve(root, filePath)
const rel = path.relative(root.toLowerCase(), abs.toLowerCase()).split(path.sep).join('/')
const top = rel.split('/')[0]

const checks = []
if (top === 'server' || top === 'shared') checks.push(['node --check', [ '--check', abs ], root])
if (top === 'client' || top === 'shared') checks.push(['client check-imports', ['scripts/check-imports.js'], path.join(root, 'client')])

let failed = false
for (const [name, args, cwd] of checks) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) {
    failed = true
    console.error(`[${name}] failed after editing ${rel}:\n${(r.stderr || r.stdout || '').trim()}`)
  }
}
process.exit(failed ? 2 : 0)
