#!/usr/bin/env node
// Regenerates the claim status transition reference-data migration from the
// single source of truth in shared/workflow.js. Run: npm run db:transitions-sql
// Earlier generated migrations stay unchanged; this file is the current one.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { TRANSITIONS } from '../../shared/workflow.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '../../database/migrations/20261027000013_workflow_transitions.sql')

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`
const rows = TRANSITIONS.map(
  (t) =>
    `  (${quote(t.from)}, ${quote(t.to)}, array[${t.roles.map(quote).join(', ')}]::text[], ${Boolean(t.requiresReason)}, ${Boolean(t.systemOnly)})`,
)

const sql = `-- GENERATED FILE — do not edit by hand.
-- Source: shared/workflow.js (regenerate with \`npm run db:transitions-sql\`).
-- Used by the claims_enforce_status_rules trigger as a database-level backstop
-- for the API workflow service.

delete from public.claim_status_transitions;

insert into public.claim_status_transitions (from_status, to_status, allowed_roles, requires_reason, system_only) values
${rows.join(',\n')};
`

writeFileSync(target, sql)
console.log(`Wrote ${TRANSITIONS.length} transitions to ${path.relative(process.cwd(), target)}`)
