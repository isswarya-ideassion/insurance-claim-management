import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './evaluations.controller.js'
import { evaluationFieldsSchema, idParams, returnEvaluationSchema, submitEvaluationSchema } from './evaluations.validators.js'

export function evaluationsRoutes() {
  const router = Router()
  router.get('/claims/:id/evaluations', validate({ params: idParams }), controller.list)
  router.post('/claims/:id/evaluations', validate({ params: idParams, body: evaluationFieldsSchema }), controller.create)
  router.patch('/evaluations/:id', validate({ params: idParams, body: evaluationFieldsSchema }), controller.update)
  router.post('/evaluations/:id/submit', validate({ params: idParams, body: submitEvaluationSchema }), controller.submit)
  router.post('/evaluations/:id/return', validate({ params: idParams, body: returnEvaluationSchema }), controller.returnForCorrection)
  return router
}
