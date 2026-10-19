import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './reserves.controller.js'
import { decisionSchema, idParams, queueQuery } from './reserves.validators.js'

export function reservesRoutes() {
  const router = Router()
  router.get('/claims/:id/reserves', validate({ params: idParams }), controller.listForClaim)
  router.get('/reserves/queue', validate({ query: queueQuery }), controller.queue)
  router.post('/reserves/:id/decision', validate({ params: idParams, body: decisionSchema }), controller.decide)
  return router
}
