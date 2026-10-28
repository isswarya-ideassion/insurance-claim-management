import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './config.controller.js'
import { decisionSchema, idParams, proposalSchema } from './config.validators.js'

export function configRoutes() {
  const router = Router()
  router.get('/config/segments', controller.segments)
  router.post('/config/segments', validate({ body: proposalSchema }), controller.propose)
  router.post('/config/segments/:id/decision', validate({ params: idParams, body: decisionSchema }), controller.decide)
  router.get('/config/authority-limits', controller.authorityLimits)
  router.get('/config/fraud-reason-codes', controller.fraudReasonCodes)
  return router
}
