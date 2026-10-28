import { ok } from '../../utils/http.js'
import * as service from './audit.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listAuditLogs(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function forClaim(req, res) {
  const { items, meta } = await service.claimAuditTrail(req.ctx, req.params.id)
  ok(res, items, meta)
}

export async function verify(req, res) {
  ok(res, await service.verifyChain(req.ctx))
}
