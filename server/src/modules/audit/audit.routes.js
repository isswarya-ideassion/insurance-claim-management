import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './audit.controller.js'
import { auditQuery, idParams } from './audit.validators.js'

export function auditRoutes() {
  const router = Router()
  router.get('/audit-logs', validate({ query: auditQuery }), controller.list)
  router.get('/claims/:id/audit', validate({ params: idParams }), controller.forClaim)
  return router
}
