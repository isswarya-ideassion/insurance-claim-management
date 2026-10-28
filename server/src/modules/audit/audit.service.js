import { pageMeta, toOffset } from '../../utils/http.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { loadAccessibleClaim, requirePermission, requireStaffView } from '../../services/access.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

export async function listAuditLogs(ctx, query) {
  requirePermission(ctx.actor, 'audit.view')
  const where = {}
  if (query.claimId) {
    await loadAccessibleClaim(ctx.db, ctx.actor, query.claimId)
    where.claim_id = query.claimId
  }
  if (query.actorId) where.actor_id = query.actorId
  if (query.entityType) where.entity_type = query.entityType
  if (query.action) where.action = { ilike: `%${escapeLike(query.action)}%` }
  if (query.from || query.to) {
    where.created_at = {
      gte: query.from,
      lte: query.to ? new Date(new Date(query.to).getTime() + 86_399_999) : undefined,
    }
  }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('audit_logs', { where, orderBy: [['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('audit_logs', where),
  ])
  const names = await profileMap(ctx.db, rows.map((r) => r.actor_id))
  const claimIds = [...new Set(rows.map((r) => r.claim_id).filter(Boolean))]
  const claims = claimIds.length ? await ctx.db.findMany('claims', { where: { id: { in: claimIds } }, columns: ['id', 'claim_number'] }) : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c.claim_number]))
  return {
    items: rows.map((r) => ({ ...r, actor_name: nameOf(names, r.actor_id) || (r.actor_id ? null : 'System'), claim_number: claimMap[r.claim_id] || null })),
    meta: pageMeta(query, total),
  }
}

export async function claimAuditTrail(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireStaffView(ctx.actor, claim)
  requirePermission(ctx.actor, 'audit.view')
  return listAuditLogs(ctx, { claimId, page: 1, pageSize: 100 })
}
