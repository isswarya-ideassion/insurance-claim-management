import { ok } from '../../utils/http.js'
import * as service from './notifications.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listNotifications(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function unreadCount(req, res) {
  ok(res, await service.unreadCount(req.ctx))
}

export async function markRead(req, res) {
  ok(res, await service.markRead(req.ctx, req.params.id))
}

export async function markAllRead(req, res) {
  ok(res, await service.markAllRead(req.ctx))
}
