import { ok, created } from '../../utils/http.js'
import { uploadFieldsSchema } from './documents.validators.js'
import * as service from './documents.service.js'

export async function list(req, res) {
  ok(res, await service.listClaimDocuments(req.ctx, req.params.id))
}

export async function upload(req, res) {
  const fields = uploadFieldsSchema.parse(req.body || {})
  created(res, await service.uploadDocument(req.ctx, req.params.id, req.file, fields))
}

export async function download(req, res) {
  const { doc, buffer } = await service.downloadDocument(req.ctx, req.params.id, req.validatedQuery.version)
  const disposition = req.validatedQuery.disposition
  res.set({
    'Content-Type': doc.mime_type,
    'Content-Length': String(buffer.length),
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  })
  res.end(buffer)
}

export async function versions(req, res) {
  ok(res, await service.versions(req.ctx, req.params.id))
}

export async function reviewQueue(req, res) {
  const { items, meta } = await service.reviewQueue(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function review(req, res) {
  ok(res, await service.reviewDocument(req.ctx, req.params.id, req.body))
}

export async function assignReviewer(req, res) {
  ok(res, await service.assignReviewer(req.ctx, req.params.id, req.body))
}

export async function listClaimRequirements(req, res) {
  ok(res, await service.listClaimRequirements(req.ctx, req.params.id))
}

export async function listRequests(req, res) {
  const { items, meta } = await service.listRequests(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function createRequest(req, res) {
  created(res, await service.createArtifactRequest(req.ctx, req.params.id, req.body))
}

export async function respond(req, res) {
  ok(res, await service.respondToRequest(req.ctx, req.params.id, req.body))
}

export async function closeRequest(req, res) {
  ok(res, await service.closeRequest(req.ctx, req.params.id))
}
