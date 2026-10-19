import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './payments.controller.js'
import { beneficiarySchema, idParams, listPaymentsQuery, reconcileSchema, retrySchema } from './payments.validators.js'

export function paymentsRoutes() {
  const router = Router()
  const byId = validate({ params: idParams })
  router.get('/payments', validate({ query: listPaymentsQuery }), controller.list)
  router.get('/payments/mine', controller.mine)
  router.get('/payments/reconciliation/summary', controller.reconciliation)
  router.get('/payments/:id', byId, controller.get)
  router.get('/payments/:id/beneficiary', byId, controller.beneficiary)
  router.post('/payments/:id/process', byId, controller.process)
  router.post('/payments/:id/retry', validate({ params: idParams, body: retrySchema }), controller.retry)
  router.patch('/payments/:id/beneficiary', validate({ params: idParams, body: beneficiarySchema }), controller.updateBeneficiary)
  router.post('/payments/:id/reconcile', validate({ params: idParams, body: reconcileSchema }), controller.reconcile)
  router.get('/claims/:id/payments', byId, controller.listForClaim)
  router.get('/claims/:id/payment-status', byId, controller.claimStatus)
  return router
}
