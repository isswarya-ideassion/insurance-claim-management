import { ok } from '../../utils/http.js'
import * as service from './approvals.service.js'

export async function claimSettlements(req, res) {
  ok(res, await service.listClaimSettlements(req.ctx, req.params.id))
}

export async function settlementQueue(req, res) {
  const { items, meta } = await service.settlementQueue(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function decideSettlement(req, res) {
  ok(res, await service.decideSettlement(req.ctx, req.params.id, req.body))
}

export async function claimApprovals(req, res) {
  ok(res, await service.listClaimApprovals(req.ctx, req.params.id))
}

export async function history(req, res) {
  const { items, meta } = await service.approvalHistory(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}
