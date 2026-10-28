import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './integrations.controller.js'
import { precedenceSchema, recordRunSchema, runsQuery, xrefQuery, xrefSchema } from './integrations.validators.js'

export function integrationsRoutes() {
  const router = Router()
  router.get('/integrations/runs', validate({ query: runsQuery }), controller.runs)
  router.post('/integrations/runs', validate({ body: recordRunSchema }), controller.recordRun)
  router.get('/integrations/xref', validate({ query: xrefQuery }), controller.xref)
  router.post('/integrations/xref', validate({ body: xrefSchema }), controller.linkXref)
  router.get('/integrations/source-precedence', controller.precedence)
  router.put('/integrations/source-precedence', validate({ body: precedenceSchema }), controller.setPrecedence)
  return router
}
