import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './closure.controller.js'
import { closureDecisionSchema, closureRequestSchema, idParams, recoverySchema, recoveryUpdateSchema } from './closure.validators.js'

export function closureRoutes() {
  const router = Router()
  router.get('/claims/:id/closure-requests', validate({ params: idParams }), controller.list)
  router.post('/claims/:id/closure-requests', validate({ params: idParams, body: closureRequestSchema }), controller.request)
  router.post('/closure-requests/:id/decision', validate({ params: idParams, body: closureDecisionSchema }), controller.decide)
  router.get('/claims/:id/recoveries', validate({ params: idParams }), controller.recoveries)
  router.post('/claims/:id/recoveries', validate({ params: idParams, body: recoverySchema }), controller.createRecovery)
  router.patch('/recoveries/:id', validate({ params: idParams, body: recoveryUpdateSchema }), controller.updateRecovery)
  return router
}
