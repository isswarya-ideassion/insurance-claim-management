import { created, ok } from '../../utils/http.js'
import * as service from './policies.service.js'
import * as renewals from './renewals.service.js'

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

export async function requestRenewal(req, res) {
  created(res, await renewals.requestRenewal(req.ctx, req.params.id, req.body))
}

export async function listRenewals(req, res) {
  const { items, meta } = await renewals.listRenewals(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function decideRenewal(req, res) {
  ok(res, await renewals.decideRenewal(req.ctx, req.params.id, req.body))
}
