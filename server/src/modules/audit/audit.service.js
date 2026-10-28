import { ROLES } from '../../../../shared/constants.js'
import { can } from '../../../../shared/permissions.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { claimScope, loadAccessibleClaim, requirePermission, requireStaffView } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const PIPELINE_ENTITIES = ['integration', 'system', 'job']

/**
 * Audit search with ABAC limits: Compliance & Security see everything; Ops
 * Managers see claim events within their scope; Data Engineers see pipeline
 * and system events (PRD authorization matrix: audit logs).
 */
async function auditScope(ctx) {
  if (can(ctx.actor.roles, 'audit.viewAll')) return {}
  const branches = []
  if (ctx.actor.roles.includes(ROLES.OPS_MANAGER)) {
    const scope = await claimScope(ctx.db, ctx.actor)
    const ids = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
    branches.push({ claim_id: { in: ids } })
  }
  if (ctx.actor.roles.includes(ROLES.DATA_ENGINEER)) branches.push({ entity_type: { in: PIPELINE_ENTITIES } })
  return { $or: branches }
}

export async function listAuditLogs(ctx, query) {
  requirePermission(ctx.actor, 'audit.view')
  const filters = [await auditScope(ctx)]
  if (query.claimId) {
    await loadAccessibleClaim(ctx.db, ctx.actor, query.claimId)
    filters.push({ claim_id: query.claimId })
  }
  if (query.actorId) filters.push({ actor_id: query.actorId })
  if (query.actorType) filters.push({ actor_type: query.actorType })
  if (query.entityType) filters.push({ entity_type: query.entityType })
  if (query.action) filters.push({ action: { ilike: `%${escapeLike(query.action)}%` } })
  if (query.from || query.to) {
    filters.push({
      occurred_at: {
        gte: query.from,
        lte: query.to ? new Date(new Date(query.to).getTime() + 86_399_999) : undefined,
      },
    })
  }
  const where = { $and: filters }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('audit_logs', { where, orderBy: [['occurred_at', 'desc'], ['seq', 'desc']], ...toOffset(query) }),
    ctx.db.count('audit_logs', where),
  ])
  const names = await profileMap(ctx.db, rows.map((r) => r.actor_id))
  const claimIds = [...new Set(rows.map((r) => r.claim_id).filter(Boolean))]
  const claims = claimIds.length ? await ctx.db.findMany('claims', { where: { id: { in: claimIds } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  return {
    items: rows.map((r) => ({ ...r, actor_name: nameOf(names, r.actor_id) || (r.actor_type === 'SYSTEM' ? 'System' : null), claim_number: claimMap[r.claim_id] || null })),
    meta: pageMeta(query, total),
  }
}

export async function claimAuditTrail(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireStaffView(ctx.actor, claim)
  requirePermission(ctx.actor, 'audit.view')
  return listAuditLogs(ctx, { claimId, page: 1, pageSize: 100 })
}

/** Recomputes the audit hash chain in the database; an empty problem list means it is intact. */
export async function verifyChain(ctx) {
  requirePermission(ctx.actor, 'audit.viewAll')
  const problems = await ctx.db.query('select * from public.verify_audit_chain() limit 100')
  const [{ count }] = await ctx.db.query('select count(*)::int as count from public.audit_logs')
  const result = { intact: problems.length === 0, rowsChecked: count, problems }
  await recordAudit(ctx.db, ctx.actor, { action: 'AUDIT_CHAIN_VERIFIED', entityType: 'system', metadata: { intact: result.intact, rowsChecked: count } })
  return result
}
