import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './customers.controller.js'
import { customerDocumentParams, customerParams, downloadQuery, exportCustomersQuery, listCustomersQuery } from './customers.validators.js'

export function customersRoutes() {
  const router = Router()
  router.get('/customers', validate({ query: listCustomersQuery }), controller.list)
  router.get('/customers/export', validate({ query: exportCustomersQuery }), controller.exportCsv)
  router.get('/customers/:id', validate({ params: customerParams }), controller.get)
  router.get(
    '/customers/:id/documents/:documentId/download',
    validate({ params: customerDocumentParams, query: downloadQuery }),
    controller.downloadDocument,
  )
  return router
}
