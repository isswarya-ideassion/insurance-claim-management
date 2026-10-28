import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './policies.controller.js'
import {
  eligibilitySchema,
  listPoliciesQuery,
  listRenewalsQuery,
  policyIdParams,
  renewalDecisionSchema,
  renewalIdParams,
  renewalRequestSchema,
} from './policies.validators.js'

export function policiesRoutes() {
  const router = Router()
  router.get('/policies', validate({ query: listPoliciesQuery }), controller.list)
  router.post('/policies/eligibility', validate({ body: eligibilitySchema }), controller.eligibility)
  router.get('/policies/:id', validate({ params: policyIdParams }), controller.get)
  router.post('/policies/:id/renewal-requests', validate({ params: policyIdParams, body: renewalRequestSchema }), controller.requestRenewal)
  router.get('/policy-renewals', validate({ query: listRenewalsQuery }), controller.listRenewals)
  router.post('/policy-renewals/:id/decision', validate({ params: renewalIdParams, body: renewalDecisionSchema }), controller.decideRenewal)
  return router
}
