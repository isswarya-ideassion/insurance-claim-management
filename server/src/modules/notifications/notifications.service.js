import { notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'

export async function listNotifications(ctx, query) {
  const where = { recipient_id: ctx.actor.id }
  if (query.unread === 'true') where.is_read = false
  const [items, total, unread] = await Promise.all([
    ctx.db.findMany('notifications', { where, orderBy: [['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('notifications', where),
    ctx.db.count('notifications', { recipient_id: ctx.actor.id, is_read: false }),
  ])
  return { items, meta: { ...pageMeta(query, total), unread } }
}

export async function unreadCount(ctx) {
  return { unread: await ctx.db.count('notifications', { recipient_id: ctx.actor.id, is_read: false }) }
}

export async function markRead(ctx, id) {
  const [row] = await ctx.db.update('notifications', { id, recipient_id: ctx.actor.id }, { is_read: true, read_at: new Date() })
  if (!row) throw notFound('Notification not found')
  return row
}

export async function markAllRead(ctx) {
  const rows = await ctx.db.update('notifications', { recipient_id: ctx.actor.id, is_read: false }, { is_read: true, read_at: new Date() })
  return { updated: rows.length }
}
