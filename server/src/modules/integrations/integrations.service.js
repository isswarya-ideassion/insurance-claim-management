import { businessRule, notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

/**
 * Integration state for the Data Engineer (PRD 6.5, 6.6): sync-run history,
 * the claim cross-reference to source systems, and source precedence rules.
 * Source-system adapters are not part of this release; runs are recorded by
 * the pipelines that perform them.
 */
export async function listRuns(ctx, query) {
  requirePermission(ctx.actor, 'integrations.view')
  const where = {}
  if (query.source) where.source_system = query.source
  if (query.status) where.status = query.status
  const [rows, total] = await Promise.all([
    ctx.db.findMany('integration_sync_runs', { where, orderBy: [['started_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('integration_sync_runs', where),
  ])
  return { items: rows, meta: pageMeta(query, total) }
}

export async function recordRun(ctx, input) {
  requirePermission(ctx.actor, 'integrations.manage')
  return ctx.db.tx(async (t) => {
    const run = await t.insert('integration_sync_runs', {
      source_system: input.sourceSystem,
      started_at: input.startedAt || new Date(),
      finished_at: input.finishedAt || null,
      records_in: input.recordsIn,
      records_failed: input.recordsFailed,
      status: input.status,
      checkpoint: input.checkpoint || null,
      error: input.error || null,
      triggered_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'SYNC_RUN_RECORDED', entityType: 'integration', entityId: run.id, after: run })
    return run
  })
}

export async function listXref(ctx, query) {
  requirePermission(ctx.actor, 'integrations.view')
  const where = {}
  if (query.claimId) where.claim_id = query.claimId
  if (query.status) where.status = query.status
  const [rows, total] = await Promise.all([
    ctx.db.findMany('claim_xref', { where, orderBy: [['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('claim_xref', where),
  ])
  const claims = rows.length ? await ctx.db.findMany('claims', { where: { id: { in: rows.map((r) => r.claim_id) } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  return { items: rows.map((r) => ({ ...r, claim_number: claimMap[r.claim_id] || null })), meta: pageMeta(query, total) }
}

/** Manual match from the Data Engineer's match queue (PRD 6.6). */
export async function linkXref(ctx, { claimId, sourceSystem, externalClaimId }) {
  requirePermission(ctx.actor, 'integrations.manage')
  return ctx.db.tx(async (t) => {
    const claim = await t.findById('claims', claimId)
    if (!claim || claim.status === 'DRAFT') throw notFound('Claim not found')
    if (await t.findOne('claim_xref', { source_system: sourceSystem, external_claim_id: externalClaimId })) {
      throw businessRule('ALREADY_LINKED', `${sourceSystem} claim ${externalClaimId} is already linked`)
    }
    const row = await t.insert('claim_xref', {
      claim_id: claimId,
      source_system: sourceSystem,
      external_claim_id: externalClaimId,
      match_method: 'MANUAL',
      match_confidence: 1,
      status: 'LINKED',
    })
    await recordAudit(t, ctx.actor, { action: 'CLAIM_XREF_LINKED', entityType: 'integration', entityId: row.id, claimId, after: row })
    return row
  })
}

export async function listPrecedence(ctx) {
  requirePermission(ctx.actor, 'integrations.view')
  const rows = await ctx.db.findMany('source_precedence', { orderBy: [['field_group', 'asc'], ['rank', 'asc']] })
  const names = await profileMap(ctx.db, rows.map((r) => r.updated_by))
  return rows.map((r) => ({ ...r, updated_by_name: nameOf(names, r.updated_by) }))
}

export async function setPrecedence(ctx, { fieldGroup, sourceSystem, rank, rule }) {
  requirePermission(ctx.actor, 'integrations.manage')
  return ctx.db.tx(async (t) => {
    const before = await t.findOne('source_precedence', { field_group: fieldGroup, source_system: sourceSystem })
    const [row] = await t.query(
      `insert into public.source_precedence (field_group, source_system, rank, rule, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (field_group, source_system) do update
         set rank = excluded.rank, rule = excluded.rule, updated_by = excluded.updated_by, updated_at = now()
       returning *`,
      [fieldGroup, sourceSystem, rank, rule, ctx.actor.id],
    )
    await recordAudit(t, ctx.actor, { action: 'SOURCE_PRECEDENCE_SET', entityType: 'integration', before, after: row })
    return row
  })
}
