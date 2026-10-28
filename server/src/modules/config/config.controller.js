import { ok, created } from '../../utils/http.js'
import * as service from './config.service.js'

export async function segments(req, res) {
  ok(res, await service.listSegmentConfig(req.ctx))
}

export async function propose(req, res) {
  created(res, await service.proposeSegmentConfig(req.ctx, req.body))
}

export async function decide(req, res) {
  ok(res, await service.decideSegmentConfig(req.ctx, req.params.id, req.body))
}

export async function authorityLimits(req, res) {
  ok(res, await service.listAuthorityLimits(req.ctx))
}

export async function fraudReasonCodes(req, res) {
  ok(res, await service.listFraudReasonCodes(req.ctx))
}
