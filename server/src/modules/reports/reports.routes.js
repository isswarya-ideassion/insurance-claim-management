import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './reports.controller.js'
import { reportQuery } from './reports.validators.js'

export function reportsRoutes() {
  const router = Router()
  router.get('/reports/summary', validate({ query: reportQuery }), controller.summary)
  return router
}
