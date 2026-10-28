import { ok, created } from '../../utils/http.js'
import * as service from './tasks.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listTasks(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function listForClaim(req, res) {
  const { items, meta } = await service.listTasks(req.ctx, { claimId: req.params.id, page: 1, pageSize: 100 })
  ok(res, items, meta)
}

export async function create(req, res) {
  created(res, await service.createTask(req.ctx, req.body))
}

export async function update(req, res) {
  ok(res, await service.updateTask(req.ctx, req.params.id, req.body))
}
