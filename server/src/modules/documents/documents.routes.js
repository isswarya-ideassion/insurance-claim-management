import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { uploadSingle } from '../../middleware/upload.js'
import * as controller from './documents.controller.js'
import {
  assignReviewerSchema,
  downloadQuery,
  idParams,
  informationRequestSchema,
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

  router.get('/claims/:id/information-requests', byId, controller.listClaimRequests)
  router.post('/claims/:id/information-requests', validate({ params: idParams, body: informationRequestSchema }), controller.createRequest)
  router.get('/information-requests', validate({ query: listRequestsQuery }), controller.listRequests)
  router.post('/information-requests/:id/respond', validate({ params: idParams, body: respondSchema }), controller.respond)
  router.post('/information-requests/:id/close', byId, controller.closeRequest)

  return router
}
