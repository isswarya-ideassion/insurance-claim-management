import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './claims.controller.js'
import {
  claimIdParams,
  coverageSchema,
  documentExceptionSchema,
  draftSchema,
  escalateSchema,
  intakeChecklistSchema,
  listClaimsQuery,
  noteSchema,
  submitSchema,
  transitionSchema,
} from './claims.validators.js'

export function claimsRoutes() {
  const router = Router()
  const byId = validate({ params: claimIdParams })

  router.get('/claims', validate({ query: listClaimsQuery }), controller.list)
  router.get('/claims/stats', controller.stats)
  router.post('/claims', validate({ body: draftSchema }), controller.createDraft)
  // PATCH bodies are validated in the controller: drafts and staff metadata use different schemas.
  router.get('/claims/:id', byId, controller.detail)
  router.patch('/claims/:id', byId, controller.update)
  router.delete('/claims/:id', byId, controller.remove)
  router.post('/claims/:id/submit', byId, validate({ body: submitSchema }), controller.submit)
  router.get('/claims/:id/transitions', byId, controller.transitions)
  router.post('/claims/:id/transitions', byId, validate({ body: transitionSchema }), controller.changeStatus)
  router.post('/claims/:id/coverage-check', byId, validate({ body: coverageSchema }), controller.coverageCheck)
  router.get('/claims/:id/coverage-results', byId, controller.coverageResults)
  router.get('/claims/:id/sla-clocks', byId, controller.slaClocks)
  router.patch('/claims/:id/intake-checklist', byId, validate({ body: intakeChecklistSchema }), controller.intakeChecklist)
  router.post('/claims/:id/escalate', byId, validate({ body: escalateSchema }), controller.escalate)
  router.post('/claims/:id/document-exception', byId, validate({ body: documentExceptionSchema }), controller.documentException)
  router.get('/claims/:id/notes', byId, controller.notes)
  router.post('/claims/:id/notes', byId, validate({ body: noteSchema }), controller.addNote)
  router.get('/claims/:id/timeline', byId, controller.timeline)

  return router
}
