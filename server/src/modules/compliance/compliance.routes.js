import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './compliance.controller.js'
import { decisionSchema, idParams, openReviewSchema, queueQuery, updateReviewSchema } from './compliance.validators.js'

export function complianceRoutes() {
  const router = Router()
  router.get('/compliance/queue', validate({ query: queueQuery }), controller.queue)
  router.get('/claims/:id/compliance-reviews', validate({ params: idParams }), controller.listForClaim)
  router.post('/claims/:id/compliance-reviews', validate({ params: idParams, body: openReviewSchema }), controller.open)
  router.patch('/compliance-reviews/:id', validate({ params: idParams, body: updateReviewSchema }), controller.update)
  router.post('/compliance-reviews/:id/decision', validate({ params: idParams, body: decisionSchema }), controller.decide)
  return router
}
