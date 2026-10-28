import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './settlements.controller.js'
import { decisionSchema, historyQuery, idParams, queueQuery } from './settlements.validators.js'

export function settlementsRoutes() {
  const router = Router()
  router.get('/claims/:id/settlements', validate({ params: idParams }), controller.claimSettlements)
  router.get('/settlements/queue', validate({ query: queueQuery }), controller.settlementQueue)
  // Records the decision on the settlement's pending approval step (PRD: POST /settlements/{id}/approvals).
  router.post('/settlements/:id/approvals', validate({ params: idParams, body: decisionSchema }), controller.decideSettlement)
  router.get('/claims/:id/approvals', validate({ params: idParams }), controller.claimApprovals)
  router.get('/approvals', validate({ query: historyQuery }), controller.history)
  return router
}
