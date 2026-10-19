import { ok } from '../../utils/http.js'
import { idempotencyKeySchema } from './payments.validators.js'
import * as service from './payments.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listPayments(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function get(req, res) {
  ok(res, await service.getPayment(req.ctx, req.params.id))
}

export async function listForClaim(req, res) {
  ok(res, await service.listClaimPayments(req.ctx, req.params.id))
}

export async function claimStatus(req, res) {
  ok(res, await service.claimPaymentStatus(req.ctx, req.params.id))
}

export async function mine(req, res) {
  ok(res, await service.myPayments(req.ctx))
}

export async function beneficiary(req, res) {
  ok(res, await service.revealBeneficiary(req.ctx, req.params.id))
}

export async function process(req, res) {
  const key = idempotencyKeySchema.parse(req.get('idempotency-key'))
  const result = await service.processPayment(req.ctx, req.params.id, key)
  ok(res, result, { replayed: result.replayed, simulated: req.ctx.payments.isSimulated })
}

export async function retry(req, res) {
  ok(res, await service.retryPayment(req.ctx, req.params.id, req.body))
}

export async function updateBeneficiary(req, res) {
  ok(res, await service.updateBeneficiary(req.ctx, req.params.id, req.body))
}

export async function reconcile(req, res) {
  ok(res, await service.reconcilePayment(req.ctx, req.params.id, req.body))
}

export async function reconciliation(req, res) {
  ok(res, await service.reconciliationSummary(req.ctx))
}
