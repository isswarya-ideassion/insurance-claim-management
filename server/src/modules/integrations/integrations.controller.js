import { ok, created } from '../../utils/http.js'
import * as service from './integrations.service.js'

export async function runs(req, res) {
  const { items, meta } = await service.listRuns(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function recordRun(req, res) {
  created(res, await service.recordRun(req.ctx, req.body))
}

export async function xref(req, res) {
  const { items, meta } = await service.listXref(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function linkXref(req, res) {
  created(res, await service.linkXref(req.ctx, req.body))
}

export async function precedence(req, res) {
  ok(res, await service.listPrecedence(req.ctx))
}

export async function setPrecedence(req, res) {
  ok(res, await service.setPrecedence(req.ctx, req.body))
}
