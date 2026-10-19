import { ROLES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { notFound, forbidden } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { maskAccount } from '../../utils/format.js'
import { toOffset, pageMeta } from '../../utils/http.js'
import { evaluatePolicyEligibility } from '../../services/eligibility.service.js'

const POLICY_STAFF = [
  ROLES.CLAIMS_OPERATIONS,
  ROLES.CLAIMS_MANAGER,
  ROLES.DOCUMENT_REVIEWER,
  ROLES.CLAIMS_ADJUSTER,
  ROLES.COMPLIANCE_OFFICER,
  ROLES.AUDITOR,
]

export function presentPolicy(policy) {
  if (!policy) return null
  const { payout_account_number: account, ...rest } = policy
  return { ...rest, payout_account_masked: maskAccount(account) }
}

function policyScope(user) {
  if (hasAnyRole(user.roles, POLICY_STAFF)) return {}
  if (user.roles.includes(ROLES.CUSTOMER)) return { holder_id: user.id }
  return null
}

export async function listPolicies(ctx, query) {
  const scope = policyScope(ctx.actor)
  if (!scope) throw forbidden('Your role cannot view policies')
  const where = { ...scope }
  if (query.status) where.status = query.status
  if (query.type) where.policy_type = query.type
  if (query.search) {
    const term = `%${escapeLike(query.search)}%`
    where.$or = [{ policy_number: { ilike: term } }, { insured_name: { ilike: term } }]
  }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('policies', { where, orderBy: [['effective_to', 'desc']], ...toOffset(query) }),
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
  return {
    items: rows.map((p) => ({ ...presentPolicy(p), claims_count: countMap[p.id] || 0 })),
    meta: pageMeta(query, total),
  }
}

export async function getPolicy(ctx, id) {
  const scope = policyScope(ctx.actor)
  if (!scope) throw forbidden('Your role cannot view policies')
  const policy = await ctx.db.findOne('policies', { id, ...scope })
  if (!policy) throw notFound('Policy not found')
  return presentPolicy(policy)
}

export async function checkEligibility(ctx, input) {
  const policy = await ctx.db.findOne('policies', { policy_number: input.policyNumber.toUpperCase() })
  // Customers only learn about policies they own; others get a generic not-found result.
  const visible = policy && (policy.holder_id === ctx.actor.id || hasAnyRole(ctx.actor.roles, POLICY_STAFF))
  const result = evaluatePolicyEligibility(visible ? policy : null, {
    customerId: policy && hasAnyRole(ctx.actor.roles, POLICY_STAFF) && policy.holder_id !== ctx.actor.id
      ? policy.holder_id
      : ctx.actor.id,
    incidentAt: input.incidentAt,
    claimType: input.claimType,
    incidentCategory: input.incidentCategory,
    estimatedLoss: input.estimatedLoss,
  })
  return { ...result, policy: visible ? presentPolicy(policy) : null }
}
