import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { uploadSingle } from '../../middleware/upload.js'
import * as controller from './documents.controller.js'
import {
  artifactRequestSchema,
  assignReviewerSchema,
  downloadQuery,
  idParams,
  listRequestsQuery,
  respondSchema,
  reviewQueueQuery,
  reviewSchema,
} from './documents.validators.js'

export function documentsRoutes() {
  const router = Router()
  const byId = validate({ params: idParams })

  router.get('/claims/:id/documents', byId, controller.list)
  router.post('/claims/:id/documents', byId, uploadSingle, controller.upload)
  router.get('/documents/review-queue', validate({ query: reviewQueueQuery }), controller.reviewQueue)
  router.get('/documents/:id/download', validate({ params: idParams, query: downloadQuery }), controller.download)
  router.get('/documents/:id/versions', byId, controller.versions)
  router.post('/documents/:id/review', validate({ params: idParams, body: reviewSchema }), controller.review)
  router.post('/documents/:id/assign-reviewer', validate({ params: idParams, body: assignReviewerSchema }), controller.assignReviewer)

  // Artifact requirements (PRD 3.4): required artifacts per claim and requests to the client.
  router.get('/claims/:id/artifact-requirements', byId, controller.listClaimRequirements)
  router.post('/claims/:id/artifact-requests', validate({ params: idParams, body: artifactRequestSchema }), controller.createRequest)
  router.get('/artifact-requests', validate({ query: listRequestsQuery }), controller.listRequests)
  router.post('/artifact-requests/:id/respond', validate({ params: idParams, body: respondSchema }), controller.respond)
  router.post('/artifact-requests/:id/close', byId, controller.closeRequest)

  return router
}
