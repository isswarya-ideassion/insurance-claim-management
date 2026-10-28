import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './notifications.controller.js'
import { idParams, listNotificationsQuery } from './notifications.validators.js'

export function notificationsRoutes() {
  const router = Router()
  router.get('/notifications', validate({ query: listNotificationsQuery }), controller.list)
  router.get('/notifications/unread-count', controller.unreadCount)
  router.post('/notifications/read-all', controller.markAllRead)
  router.post('/notifications/:id/read', validate({ params: idParams }), controller.markRead)
  return router
}
