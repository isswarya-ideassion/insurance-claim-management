import { ok } from '../../utils/http.js'
import * as service from './policies.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listPolicies(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function get(req, res) {
  ok(res, await service.getPolicy(req.ctx, req.params.id))
}

export async function eligibility(req, res) {
  ok(res, await service.checkEligibility(req.ctx, req.body))
}
