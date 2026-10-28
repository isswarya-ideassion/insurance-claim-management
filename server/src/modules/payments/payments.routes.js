import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './payments.controller.js'
import { beneficiarySchema, claimPayeeSchema, idParams, listPaymentsQuery, reconcileSchema, resolveBlockSchema, verifyPayeeSchema } from './payments.validators.js'

export function paymentsRoutes() {
  const router = Router()
  const byId = validate({ params: idParams })
  router.get('/payments', validate({ query: listPaymentsQuery }), controller.list)
  router.get('/payments/mine', controller.mine)
  router.get('/payments/reconciliation/summary', controller.reconciliation)
  router.get('/payments/:id', byId, controller.get)
  router.get('/payments/:id/beneficiary', byId, controller.beneficiary)
  router.post('/payments/:id/issue', byId, controller.issue)
  router.post('/payments/:id/resolve-block', validate({ params: idParams, body: resolveBlockSchema }), controller.resolveBlock)
  router.patch('/payments/:id/beneficiary', validate({ params: idParams, body: beneficiarySchema }), controller.updateBeneficiary)
  router.post('/payments/:id/reconcile', validate({ params: idParams, body: reconcileSchema }), controller.reconcile)
  router.post('/payees/:id/verify', validate({ params: idParams, body: verifyPayeeSchema }), controller.verifyPayee)
  // Payee collection and verification at intake (Claims Operations Manager).
  router.get('/claims/:id/payee', byId, controller.claimPayee)
  router.put('/claims/:id/payee', validate({ params: idParams, body: claimPayeeSchema }), controller.recordClaimPayee)
  router.get('/claims/:id/payments', byId, controller.listForClaim)
  router.get('/claims/:id/payment-status', byId, controller.claimStatus)
  return router
}
