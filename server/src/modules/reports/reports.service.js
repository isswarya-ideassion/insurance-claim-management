import { ROLES, STATUS_LABELS, ACTIVE_STATUSES } from '../../../../shared/constants.js'
import { can } from '../../../../shared/permissions.js'
import { requirePermission, claimScope } from '../../services/access.service.js'

async function scopedClaimIds(ctx) {
  const scope = await claimScope(ctx.db, ctx.actor)
  if (!scope) {
    if (ctx.actor.roles.includes(ROLES.DATA_ADMIN)) {
      return (await ctx.db.findMany('claims', { where: { status: { ne: 'DRAFT' } }, columns: ['id'] })).map((c) => c.id)
    }
    return []
  }
  return (await ctx.db.findMany('claims', { where: { $and: [scope, { status: { ne: 'DRAFT' } }] }, columns: ['id'] })).map((c) => c.id)
}

const round = (n, d = 1) => (n == null ? null : Math.round(Number(n) * 10 ** d) / 10 ** d)

/** Builds every report dataset from live database queries, restricted to the caller's claim scope. */
export async function buildReports(ctx, { from, to, granularity }) {
  requirePermission(ctx.actor, 'reports.view')
  const ids = await scopedClaimIds(ctx)
  const q = (sql, params = []) => ctx.db.query(sql, [ids, ...params])
  const teamMetrics = can(ctx.actor.roles, 'reports.teamMetrics')

  const [byStatus, byType, byDate, processing, processingByType, aging, overdueTasks, overdueByAssignee, docRequests, docRequestsByCategory] =
    await Promise.all([
      q(`select status, count(*)::int as count from public.claims where id = any($1) group by status order by count desc`),
      q(
        `select claim_type, count(*)::int as count, coalesce(sum(estimated_loss), 0)::numeric(14,2) as claimed
           from public.claims where id = any($1) and submitted_at between $2 and $3 group by claim_type order by count desc`,
        [from, to],
      ),
      q(
        `select date_trunc($4, submitted_at at time zone 'utc')::date as period, count(*)::int as count
           from public.claims where id = any($1) and submitted_at between $2 and $3 group by 1 order by 1`,
        [from, to, granularity],
      ),
      q(
        `select avg(extract(epoch from (closed_at - submitted_at)) / 86400)::numeric(10,2) as avg_days,
                percentile_cont(0.5) within group (order by extract(epoch from (closed_at - submitted_at)) / 86400)::numeric(10,2) as median_days,
                count(*)::int as closed
           from public.claims where id = any($1) and closed_at between $2 and $3 and submitted_at is not null`,
        [from, to],
      ),
      q(
        `select claim_type, avg(extract(epoch from (closed_at - submitted_at)) / 86400)::numeric(10,2) as avg_days, count(*)::int as closed
           from public.claims where id = any($1) and closed_at between $2 and $3 and submitted_at is not null group by claim_type`,
        [from, to],
      ),
      q(
        `select case
                  when now() - submitted_at < interval '8 days' then '0-7 days'
                  when now() - submitted_at < interval '31 days' then '8-30 days'
                  when now() - submitted_at < interval '61 days' then '31-60 days'
                  else '60+ days' end as bucket,
                count(*)::int as count
           from public.claims where id = any($1) and status = any($2) group by 1`,
        [[...ACTIVE_STATUSES, 'ON_HOLD']],
      ),
      q(
        `select count(*)::int as count from public.tasks
          where status in ('OPEN', 'IN_PROGRESS') and due_at < now() and (claim_id = any($1) or claim_id is null)`,
      ),
      q(
        `select coalesce(p.full_name, t.assigned_role, 'Unassigned') as assignee, count(*)::int as count
           from public.tasks t left join public.profiles p on p.id = t.assignee_id
          where t.status in ('OPEN', 'IN_PROGRESS') and t.due_at < now() and (t.claim_id = any($1) or t.claim_id is null)
          group by 1 order by count desc limit 15`,
      ),
      q(
        `select count(*)::int as count,
                avg(extract(epoch from (now() - created_at)) / 86400)::numeric(10,1) as avg_age_days,
                count(*) filter (where due_at < now())::int as overdue
           from public.information_requests where claim_id = any($1) and status = 'OPEN'`,
      ),
      q(
        `select coalesce(document_category, 'INFORMATION') as category, count(*)::int as count
           from public.information_requests where claim_id = any($1) and status = 'OPEN' group by 1 order by count desc`,
      ),
    ])

  const [turnaround, paymentAttempts, paymentStatuses] = await Promise.all([
    q(
      `select a.approval_type,
              avg(extract(epoch from (a.decided_at - coalesce(r.requested_at, s.requested_at))) / 3600)::numeric(10,1) as avg_hours,
              count(*)::int as decisions,
              count(*) filter (where a.decision = 'APPROVED')::int as approved,
              count(*) filter (where a.decision = 'REJECTED')::int as rejected,
              count(*) filter (where a.decision = 'RETURNED')::int as returned
         from public.approvals a
         left join public.reserves r on r.id = a.reserve_id
         left join public.settlements s on s.id = a.settlement_id
        where a.claim_id = any($1) and a.decided_at between $2 and $3
        group by a.approval_type`,
      [from, to],
    ),
    q(
      `select pa.status, count(*)::int as count from public.payment_attempts pa
         join public.payments p on p.id = pa.payment_id
        where p.claim_id = any($1) and pa.started_at between $2 and $3 group by pa.status`,
      [from, to],
    ),
    q(
      `select status, count(*)::int as count, coalesce(sum(amount), 0)::numeric(14,2) as amount
         from public.payments where claim_id = any($1) group by status`,
    ),
  ])

  let adjusterWorkload = null
  let teamProductivity = null
  if (teamMetrics) {
    ;[adjusterWorkload, teamProductivity] = await Promise.all([
      q(
        `select p.id, p.full_name,
                count(c.id) filter (where c.status = any($2))::int as active_claims,
                count(c.id) filter (where c.status = 'INVESTIGATION')::int as investigating,
                count(c.id) filter (where c.status = any($2) and c.due_date < now())::int as overdue
           from public.user_roles ur
           join public.profiles p on p.id = ur.user_id
           left join public.claims c on c.assigned_adjuster_id = p.id and c.id = any($1)
          where ur.role_code = 'CLAIMS_ADJUSTER' and p.is_active
          group by p.id, p.full_name order by active_claims desc`,
        [[...ACTIVE_STATUSES, 'ON_HOLD']],
      ),
      q(
        `with staff as (
           select distinct p.id, p.full_name from public.profiles p
             join public.user_roles ur on ur.user_id = p.id where ur.role_code <> 'CUSTOMER' and p.is_active)
         select s.id, s.full_name,
           (select count(*) from public.tasks t where t.completed_by = s.id and t.status = 'DONE'
              and t.completed_at between $2 and $3 and (t.claim_id = any($1) or t.claim_id is null))::int as tasks_completed,
           (select count(*) from public.documents d where d.reviewed_by = s.id and d.reviewed_at between $2 and $3 and d.claim_id = any($1))::int as documents_reviewed,
           (select count(*) from public.approvals a where a.decided_by = s.id and a.decided_at between $2 and $3 and a.claim_id = any($1))::int as approvals_decided,
           (select count(*) from public.assessments x where x.adjuster_id = s.id and x.submitted_at between $2 and $3 and x.claim_id = any($1))::int as assessments_submitted
         from staff s order by s.full_name`,
        [from, to],
      ),
    ])
    teamProductivity = teamProductivity
      .map((r) => ({ ...r, total: r.tasks_completed + r.documents_reviewed + r.approvals_decided + r.assessments_submitted }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
  }

  const attemptsSucceeded = paymentAttempts.find((p) => p.status === 'SUCCEEDED')?.count || 0
  const attemptsFailed = paymentAttempts.find((p) => p.status === 'FAILED')?.count || 0
  const agingOrder = ['0-7 days', '8-30 days', '31-60 days', '60+ days']

  return {
    range: { from, to, granularity },
    scope: { claims: ids.length, teamMetrics },
    claimsByStatus: byStatus.map((r) => ({ ...r, label: STATUS_LABELS[r.status] })),
    claimsByType: byType,
    claimsByDate: byDate.map((r) => ({ period: r.period, count: r.count })),
    processingTime: {
      avgDays: round(processing[0]?.avg_days),
      medianDays: round(processing[0]?.median_days),
      closed: processing[0]?.closed || 0,
      byType: processingByType.map((r) => ({ ...r, avg_days: round(r.avg_days) })),
    },
    overdueTasks: { total: overdueTasks[0]?.count || 0, byAssignee: overdueByAssignee },
    outstandingDocumentRequests: {
      total: docRequests[0]?.count || 0,
      avgAgeDays: round(docRequests[0]?.avg_age_days),
      overdue: docRequests[0]?.overdue || 0,
      byCategory: docRequestsByCategory,
    },
    approvalTurnaround: turnaround.map((r) => ({ ...r, avg_hours: round(r.avg_hours) })),
    payments: {
      attempts: { succeeded: attemptsSucceeded, failed: attemptsFailed, successRate: attemptsSucceeded + attemptsFailed ? round((attemptsSucceeded / (attemptsSucceeded + attemptsFailed)) * 100) : null },
      byStatus: paymentStatuses,
    },
    claimAging: agingOrder.map((bucket) => ({ bucket, count: aging.find((a) => a.bucket === bucket)?.count || 0 })),
    adjusterWorkload,
    teamProductivity,
  }
}
