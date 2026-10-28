import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './reserves.controller.js'
import { idParams, queueQuery, reviewSchema, reviseSchema } from './reserves.validators.js'

export function reservesRoutes() {
  const router = Router()
  router.get('/claims/:id/reserves', validate({ params: idParams }), controller.listForClaim)
  router.post('/claims/:id/reserves', validate({ params: idParams, body: reviseSchema }), controller.revise)
  router.get('/reserves/queue', validate({ query: queueQuery }), controller.queue)
  router.post('/reserves/:id/review', validate({ params: idParams, body: reviewSchema }), controller.review)
  return router
}
