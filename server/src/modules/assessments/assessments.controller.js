import { ok, created } from '../../utils/http.js'
import * as service from './assessments.service.js'

export async function list(req, res) {
  ok(res, await service.listAssessments(req.ctx, req.params.id))
}

export async function create(req, res) {
  created(res, await service.createAssessment(req.ctx, req.params.id, req.body))
}

export async function update(req, res) {
  ok(res, await service.updateAssessment(req.ctx, req.params.id, req.body))
}

export async function submit(req, res) {
  ok(res, await service.submitAssessment(req.ctx, req.params.id, req.body))
}

export async function returnForCorrection(req, res) {
  ok(res, await service.returnAssessment(req.ctx, req.params.id, req.body))
}
