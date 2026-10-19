import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './approvals.controller.js'
import { decisionSchema, historyQuery, idParams, queueQuery } from './approvals.validators.js'

export function approvalsRoutes() {
  const router = Router()
  router.get('/claims/:id/settlements', validate({ params: idParams }), controller.claimSettlements)
  router.get('/settlements/queue', validate({ query: queueQuery }), controller.settlementQueue)
  router.post('/settlements/:id/decision', validate({ params: idParams, body: decisionSchema }), controller.decideSettlement)
  router.get('/claims/:id/approvals', validate({ params: idParams }), controller.claimApprovals)
  router.get('/approvals', validate({ query: historyQuery }), controller.history)
  return router
}
