import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './assessments.controller.js'
import { assessmentFieldsSchema, idParams, returnAssessmentSchema, submitAssessmentSchema } from './assessments.validators.js'

export function assessmentsRoutes() {
  const router = Router()
  router.get('/claims/:id/assessments', validate({ params: idParams }), controller.list)
  router.post('/claims/:id/assessments', validate({ params: idParams, body: assessmentFieldsSchema }), controller.create)
  router.patch('/assessments/:id', validate({ params: idParams, body: assessmentFieldsSchema }), controller.update)
  router.post('/assessments/:id/submit', validate({ params: idParams, body: submitAssessmentSchema }), controller.submit)
  router.post('/assessments/:id/return', validate({ params: idParams, body: returnAssessmentSchema }), controller.returnForCorrection)
  return router
}
