import { ROLES } from '../../../../shared/constants.js'
import { can } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { hoursFromNow } from '../../utils/format.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

// A cancelled policy cannot be renewed; it needs a new policy.
const RENEWABLE = ['ACTIVE', 'EXPIRED', 'LAPSED']
const REVIEWERS = [ROLES.CLAIMS_OPS_MANAGER, ROLES.OPS_MANAGER, ROLES.COMPLIANCE_SECURITY]

const isoDate = (d) => d.toISOString().slice(0, 10)

/** The renewed period starts at the current expiry, or today if the policy has already expired. */
export function renewedExpiry(expiryDate, termMonths, today = new Date()) {
  const expiry = new Date(`${String(expiryDate).slice(0, 10)}T00:00:00Z`)
  const start = expiry > today ? expiry : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const next = new Date(start)
  next.setUTCMonth(next.getUTCMonth() + termMonths)
  return isoDate(next)
}

/** Latest renewal request per policy, for the policy list. */
export async function latestRenewals(t, policyIds) {
  if (!policyIds.length) return {}
  const rows = await t.query(
    `select distinct on (policy_id) * from public.policy_renewal_requests
      where policy_id = any($1) order by policy_id, requested_at desc`,
    [policyIds],
  )
  return Object.fromEntries(rows.map((r) => [r.policy_id, r]))
}

export async function requestRenewal(ctx, policyId, { termMonths = 12, notes }) {
  requirePermission(ctx.actor, 'policies.requestRenewal')
  return ctx.db.tx(async (t) => {
    const policy = await t.findOne('policies', { id: policyId, insured_id: ctx.actor.id }, { forUpdate: true })
    if (!policy) throw notFound('Policy not found')
    if (!RENEWABLE.includes(policy.status)) {
      throw businessRule('POLICY_NOT_RENEWABLE', `A ${policy.status.toLowerCase()} policy cannot be renewed. Contact HarborPoint for a new policy.`)
    }
    if (await t.findOne('policy_renewal_requests', { policy_id: policyId, status: 'REQUESTED' })) {
      throw businessRule('RENEWAL_ALREADY_REQUESTED', 'A renewal request for this policy is already being processed')
    }
    const task = await t.insert('tasks', {
      title: `Policy renewal request: ${policy.external_policy_no}`,
      description: `${policy.insured_name} asked to renew for ${termMonths} months.${notes ? ` Note: ${notes}` : ''}`,
      type: 'POLICY_RENEWAL',
      owner_role: ROLES.CLAIMS_OPS_MANAGER,
      due_at: hoursFromNow(72),
      priority: policy.status === 'ACTIVE' ? 'MEDIUM' : 'HIGH',
      created_by: ctx.actor.id,
    })
    const request = await t.insert('policy_renewal_requests', {
      policy_id: policyId,
      requested_by: ctx.actor.id,
      term_months: termMonths,
      notes: notes || null,
      task_id: task.id,
    })
    await recordAudit(t, ctx.actor, { action: 'POLICY_RENEWAL_REQUESTED', entityType: 'policy', entityId: policyId, after: request })
    await notify(ctx, t, {
      recipientIds: await userIdsWithRole(t, ROLES.CLAIMS_OPS_MANAGER),
      type: 'POLICY_RENEWAL',
      title: `Renewal requested: ${policy.external_policy_no}`,
      message: `${policy.insured_name} asked to renew policy ${policy.external_policy_no} for ${termMonths} months.`,
      link: '/policy-renewals',
    })
    return request
  })
}

export async function listRenewals(ctx, query) {
  if (!REVIEWERS.some((r) => ctx.actor.roles.includes(r))) throw forbidden('Policy renewals are handled by Claims Operations')
  const where = query.status ? { status: query.status } : {}
  const [rows, total] = await Promise.all([
    ctx.db.findMany('policy_renewal_requests', { where, orderBy: [['requested_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('policy_renewal_requests', where),
  ])
  const policies = rows.length ? await ctx.db.findMany('policies', { where: { id: { in: rows.map((r) => r.policy_id) } } }) : []
  const policyMap = Object.fromEntries(policies.map((p) => [p.id, p]))
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.requested_by, r.decided_by]))
  const items = rows.map((r) => {
    const p = policyMap[r.policy_id] || {}
    return {
      ...r,
      policy_number: p.external_policy_no,
      policy_type: p.policy_type,
      policy_status: p.status,
      insured_name: p.insured_name,
      expiry_date: p.expiry_date,
      proposed_expiry: r.status === 'REQUESTED' && p.expiry_date ? renewedExpiry(p.expiry_date, r.term_months) : null,
      requested_by_name: nameOf(names, r.requested_by),
      decided_by_name: nameOf(names, r.decided_by),
      canDecide: r.status === 'REQUESTED' && can(ctx.actor.roles, 'policies.decideRenewal') && r.requested_by !== ctx.actor.id,
    }
  })
  return { items, meta: pageMeta(query, total) }
}

export async function decideRenewal(ctx, requestId, { decision, reason }) {
  requirePermission(ctx.actor, 'policies.decideRenewal')
  return ctx.db.tx(async (t) => {
    const request = await t.findOne('policy_renewal_requests', { id: requestId }, { forUpdate: true })
    if (!request) throw notFound('Renewal request not found')
    if (request.status !== 'REQUESTED') throw businessRule('ALREADY_DECIDED', `This request is already ${request.status.toLowerCase()}`)
    if (request.requested_by === ctx.actor.id) throw forbidden('You cannot decide your own renewal request', 'SELF_APPROVAL_FORBIDDEN')
    const policy = await t.findOne('policies', { id: request.policy_id }, { forUpdate: true })
    const now = new Date()
    let updatedPolicy = policy
    const patch = { status: decision, decided_by: ctx.actor.id, decided_at: now, decision_reason: reason || null }
    if (decision === 'COMPLETED') {
      if (!RENEWABLE.includes(policy.status)) throw businessRule('POLICY_NOT_RENEWABLE', `A ${policy.status.toLowerCase()} policy cannot be renewed`)
      const newExpiry = renewedExpiry(policy.expiry_date, request.term_months, now)
      Object.assign(patch, { previous_expiry: policy.expiry_date, new_expiry: newExpiry })
      updatedPolicy = await t.updateById('policies', policy.id, { expiry_date: newExpiry, status: 'ACTIVE', updated_by: ctx.actor.id })
      await recordAudit(t, ctx.actor, { action: 'POLICY_RENEWED', entityType: 'policy', entityId: policy.id, before: policy, after: updatedPolicy })
    }
    const decided = await t.updateById('policy_renewal_requests', request.id, patch)
    if (request.task_id) {
      await t.update('tasks', { id: request.task_id, status: { in: ['OPEN', 'IN_PROGRESS'] } }, { status: 'DONE', completed_by: ctx.actor.id, completed_at: now })
    }
    await recordAudit(t, ctx.actor, { action: 'POLICY_RENEWAL_DECIDED', entityType: 'policy', entityId: policy.id, before: request, after: decided, metadata: { decision } })
    await notify(ctx, t, {
      recipientIds: [request.requested_by],
      type: 'POLICY_RENEWAL',
      title: decision === 'COMPLETED' ? `Policy ${policy.external_policy_no} renewed` : `Renewal not completed: ${policy.external_policy_no}`,
      message:
        decision === 'COMPLETED'
          ? `Your policy now runs until ${new Date(`${decided.new_expiry}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`
          : `We could not renew your policy. ${reason}`,
      link: '/customer/policies',
    })
    return { request: decided, policy: updatedPolicy }
  })
}
