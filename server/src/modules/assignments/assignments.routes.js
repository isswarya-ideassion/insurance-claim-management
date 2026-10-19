import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { requirePermission } from '../../middleware/auth.js'
import * as controller from './assignments.controller.js'
import { assigneesQuery, assignSchema, claimParams } from './assignments.validators.js'

export function assignmentsRoutes() {
  const router = Router()
  router.get('/claims/:id/assignments', validate({ params: claimParams }), controller.list)
  router.post('/claims/:id/assignments', validate({ params: claimParams, body: assignSchema }), controller.assign)
  router.get('/assignments/assignees', requirePermission('claims.viewQueue'), validate({ query: assigneesQuery }), controller.assignees)
  router.get('/assignments/workload', controller.workload)
  return router
}
