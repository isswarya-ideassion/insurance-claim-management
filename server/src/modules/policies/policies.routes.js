import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './policies.controller.js'
import { eligibilitySchema, listPoliciesQuery, policyIdParams } from './policies.validators.js'

export function policiesRoutes() {
  const router = Router()
  router.get('/policies', validate({ query: listPoliciesQuery }), controller.list)
  router.post('/policies/eligibility', validate({ body: eligibilitySchema }), controller.eligibility)
  router.get('/policies/:id', validate({ params: policyIdParams }), controller.get)
  return router
}
