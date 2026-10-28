import { ok, created } from '../../utils/http.js'
import * as service from './closure.service.js'

export async function list(req, res) {
  ok(res, await service.listClosureRequests(req.ctx, req.params.id))
}

export async function request(req, res) {
  created(res, await service.requestClosure(req.ctx, req.params.id, req.body))
}

export async function decide(req, res) {
  ok(res, await service.decideClosure(req.ctx, req.params.id, req.body))
}

export async function recoveries(req, res) {
  ok(res, await service.listRecoveries(req.ctx, req.params.id))
}

export async function createRecovery(req, res) {
  created(res, await service.createRecovery(req.ctx, req.params.id, req.body))
}

export async function updateRecovery(req, res) {
  ok(res, await service.updateRecovery(req.ctx, req.params.id, req.body))
}
