import { ok, created } from '../../utils/http.js'
import * as service from './compliance.service.js'

export async function queue(req, res) {
  const { items, meta } = await service.complianceQueue(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function listForClaim(req, res) {
  ok(res, await service.listClaimReviews(req.ctx, req.params.id))
}

export async function open(req, res) {
  created(res, await service.openReview(req.ctx, req.params.id, req.body))
}

export async function update(req, res) {
  ok(res, await service.updateReview(req.ctx, req.params.id, req.body))
}

export async function decide(req, res) {
  ok(res, await service.decideReview(req.ctx, req.params.id, req.body))
}
