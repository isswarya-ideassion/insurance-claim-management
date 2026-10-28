import { ROLES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { notFound, forbidden } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { maskLast4 } from '../../utils/format.js'
import { toOffset, pageMeta } from '../../utils/http.js'
import { evaluatePolicyEligibility } from '../../services/eligibility.service.js'
import { latestRenewals } from './renewals.service.js'

const POLICY_STAFF = [
  ROLES.CLAIMS_OPS_MANAGER,
  ROLES.OPS_MANAGER,
  ROLES.DOCUMENT_REVIEWER,
  ROLES.ADJUSTER,
  ROLES.PAYMENT_OPERATOR,
  ROLES.DATA_ENGINEER,
  ROLES.COMPLIANCE_SECURITY,
]

/** Policy for display. Payout bank details are never returned, only the masked last four digits. */
export function presentPolicy(policy, payee = null) {
  if (!policy) return null
  return {
    ...policy,
    payout_bank_name: payee?.bank_name ?? null,
    payout_account_masked: maskLast4(payee?.bank_last4),
  }
}

async function payeeMap(t, policies) {
  const ids = [...new Set(policies.map((p) => p.payee_id).filter(Boolean))]
  if (ids.length === 0) return {}
  const rows = await t.findMany('payees', { where: { id: { in: ids } }, columns: ['id', 'bank_name', 'bank_last4'] })
  return Object.fromEntries(rows.map((r) => [r.id, r]))
}

export async function presentPolicyWithPayee(t, policy) {
  if (!policy) return null
  const payees = await payeeMap(t, [policy])
  return presentPolicy(policy, payees[policy.payee_id])
}

function policyScope(user) {
  if (hasAnyRole(user.roles, POLICY_STAFF)) return {}
  if (user.roles.includes(ROLES.CLIENT)) return { insured_id: user.id }
  return null
}

export async function listPolicies(ctx, query) {
  const scope = policyScope(ctx.actor)
  if (!scope) throw forbidden('Your role cannot view policies')
  const where = { ...scope }
  if (query.status) where.status = query.status
  if (query.type) where.policy_type = query.type
  if (query.segment) where.segment = query.segment
  if (query.search) {
    const term = `%${escapeLike(query.search)}%`
    where.$or = [{ external_policy_no: { ilike: term } }, { insured_name: { ilike: term } }]
  }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('policies', { where, orderBy: [['expiry_date', 'desc']], ...toOffset(query) }),
    ctx.db.count('policies', where),
  ])
  const ids = rows.map((r) => r.id)
  const counts = ids.length
    ? await ctx.db.query(
        `select policy_id, count(*)::int as count from public.claims where policy_id = any($1) and status <> 'DRAFT' group by policy_id`,
        [ids],
      )
    : []
  const countMap = Object.fromEntries(counts.map((c) => [c.policy_id, c.count]))
  const [payees, renewals] = await Promise.all([payeeMap(ctx.db, rows), latestRenewals(ctx.db, ids)])
  return {
    items: rows.map((p) => ({ ...presentPolicy(p, payees[p.payee_id]), claims_count: countMap[p.id] || 0, renewal: renewals[p.id] || null })),
    meta: pageMeta(query, total),
  }
}

export async function getPolicy(ctx, id) {
  const scope = policyScope(ctx.actor)
  if (!scope) throw forbidden('Your role cannot view policies')
  const policy = await ctx.db.findOne('policies', { id, ...scope })
  if (!policy) throw notFound('Policy not found')
  return presentPolicyWithPayee(ctx.db, policy)
}

export async function checkEligibility(ctx, input) {
  const policy = await ctx.db.findOne('policies', { external_policy_no: input.policyNumber.toUpperCase() })
  // Clients only learn about policies they hold; others get a generic not-found result.
  const staff = hasAnyRole(ctx.actor.roles, POLICY_STAFF)
  const visible = policy && (policy.insured_id === ctx.actor.id || staff)
  const result = evaluatePolicyEligibility(visible ? policy : null, {
    customerId: policy && staff && policy.insured_id !== ctx.actor.id ? policy.insured_id : ctx.actor.id,
    lossDate: input.lossDate,
    claimType: input.claimType,
    lossType: input.lossType,
    estimatedLoss: input.estimatedLoss,
  })
  return { ...result, policy: visible ? await presentPolicyWithPayee(ctx.db, policy) : null }
}
