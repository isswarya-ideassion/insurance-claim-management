import { ok, created } from '../../utils/http.js'
import * as service from './assignments.service.js'

export async function list(req, res) {
  ok(res, await service.listAssignments(req.ctx, req.params.id))
}

export async function assign(req, res) {
  created(res, await service.assignClaim(req.ctx, req.params.id, req.body))
}

export async function assignees(req, res) {
  ok(res, await service.listAssignees(req.ctx, req.validatedQuery.role))
}

export async function workload(req, res) {
  ok(res, await service.teamWorkload(req.ctx))
}
