import { ok, created } from '../../utils/http.js'
import * as service from './reserves.service.js'

export async function listForClaim(req, res) {
  ok(res, await service.listClaimReserves(req.ctx, req.params.id))
}

export async function queue(req, res) {
  const { items, meta } = await service.reserveQueue(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function review(req, res) {
  ok(res, await service.reviewReserve(req.ctx, req.params.id, req.body))
}

export async function revise(req, res) {
  created(res, await service.reviseReserve(req.ctx, req.params.id, req.body))
}
