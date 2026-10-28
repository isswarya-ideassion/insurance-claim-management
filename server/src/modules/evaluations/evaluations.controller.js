import { ok, created } from '../../utils/http.js'
import * as service from './evaluations.service.js'

export async function list(req, res) {
  ok(res, await service.listEvaluations(req.ctx, req.params.id))
}

export async function create(req, res) {
  created(res, await service.createEvaluation(req.ctx, req.params.id, req.body))
}

export async function update(req, res) {
  ok(res, await service.updateEvaluation(req.ctx, req.params.id, req.body))
}

export async function submit(req, res) {
  ok(res, await service.submitEvaluation(req.ctx, req.params.id, req.body))
}

export async function returnForCorrection(req, res) {
  ok(res, await service.returnEvaluation(req.ctx, req.params.id, req.body))
}
