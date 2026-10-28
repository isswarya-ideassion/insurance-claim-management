import { notFound } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'

// The notification centre shows the in-app channel; email, SMS and push rows are delivery records.
const inbox = (userId) => ({ recipient_id: userId, channel: 'IN_APP' })

export async function listNotifications(ctx, query) {
  const where = inbox(ctx.actor.id)
  if (query.unread === 'true') where.read_at = null
  const [items, total, unread] = await Promise.all([
    ctx.db.findMany('notifications', { where, orderBy: [['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('notifications', where),
    ctx.db.count('notifications', { ...inbox(ctx.actor.id), read_at: null }),
  ])
  return { items: items.map((n) => ({ ...n, type: n.template, is_read: Boolean(n.read_at) })), meta: { ...pageMeta(query, total), unread } }
}

export async function unreadCount(ctx) {
  return { unread: await ctx.db.count('notifications', { ...inbox(ctx.actor.id), read_at: null }) }
}

export async function markRead(ctx, id) {
  const [row] = await ctx.db.update('notifications', { id, ...inbox(ctx.actor.id) }, { read_at: new Date(), status: 'READ' })
  if (!row) throw notFound('Notification not found')
  return { ...row, type: row.template, is_read: true }
}

export async function markAllRead(ctx) {
  const rows = await ctx.db.update('notifications', { ...inbox(ctx.actor.id), read_at: null }, { read_at: new Date(), status: 'READ' })
  return { updated: rows.length }
}
