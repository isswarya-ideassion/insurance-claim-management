import { ok, created } from '../../utils/http.js'
import * as service from './admin.service.js'

export async function users(req, res) {
  const { items, meta } = await service.listUsers(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function roles(req, res) {
  ok(res, await service.listRoles(req.ctx))
}

export async function createUser(req, res) {
  created(res, await service.createUser(req.ctx, req.body))
}

export async function grantRole(req, res) {
  ok(res, await service.grantRole(req.ctx, req.params.id, req.body))
}

export async function revokeRole(req, res) {
  ok(res, await service.revokeRole(req.ctx, req.params.id, req.params.roleCode))
}

export async function updateUser(req, res) {
  ok(res, await service.setUserActive(req.ctx, req.params.id, req.body))
}

export async function overdueSweep(req, res) {
  ok(res, await service.triggerOverdueSweep(req.ctx))
}

export async function system(req, res) {
  ok(res, service.systemInfo(req.ctx))
}
