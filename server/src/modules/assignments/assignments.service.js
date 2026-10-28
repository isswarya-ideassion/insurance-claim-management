import {
  ROLES,
  ACTIVE_STATUSES,
  OPEN_TASK_STATUSES,
  ASSIGNMENT_ROLE_REQUIRED_USER_ROLE,
  STATUS_LABELS,
} from '../../../../shared/constants.js'
import { STATUS_SLA_HOURS } from '../../../../shared/workflow.js'
import { businessRule, validationError } from '../../utils/errors.js'
import { hoursFromNow } from '../../utils/format.js'
import { loadAccessibleClaim, requirePermission, requireNotOwnClaim, requireStaffView } from '../../services/access.service.js'
import { lockClaim, transitionClaim } from '../../services/workflow.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, claimLink } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'

const CLAIM_COLUMN = {
  OPERATIONS_OWNER: 'assigned_owner_id',
  DOCUMENT_REVIEWER: 'assigned_reviewer_id',
  ADJUSTER: 'assigned_adjuster_id',
}

export async function listAssignments(ctx, claimId) {
  const claim = await loadAccessibleClaim(ctx.db, ctx.actor, claimId)
  requireStaffView(ctx.actor, claim)
  const rows = await ctx.db.findMany('claim_assignments', { where: { claim_id: claimId }, orderBy: [['assigned_at', 'desc']] })
  const names = await profileMap(ctx.db, rows.flatMap((r) => [r.assignee_id, r.assigned_by]))
  return rows.map((r) => ({ ...r, assignee_name: nameOf(names, r.assignee_id), assigned_by_name: nameOf(names, r.assigned_by) }))
}

export async function assignClaim(ctx, claimId, { assigneeId, assignmentRole, reason }) {
  requirePermission(ctx.actor, assignmentRole === 'ADJUSTER' ? 'claims.assignAdjuster' : 'claims.assign')
  return ctx.db.tx(async (t) => {
    await loadAccessibleClaim(t, ctx.actor, claimId)
    const claim = await lockClaim(t, claimId)
    requireNotOwnClaim(ctx.actor, claim)
    if (!ACTIVE_STATUSES.includes(claim.status) && claim.status !== 'ON_HOLD') {
      throw businessRule('INVALID_STAGE', `Claims in ${STATUS_LABELS[claim.status]} cannot be assigned`)
    }
    if (assigneeId === claim.customer_id) throw businessRule('CONFLICT_OF_INTEREST', 'A claimant cannot be assigned to their own claim')

    const assignee = await t.findById('profiles', assigneeId)
    if (!assignee?.is_active) throw validationError('Assignee not found or inactive')
    const assigneeRoles = (await t.findMany('user_roles', { where: { user_id: assigneeId } })).map((r) => r.role_code)
    const required = ASSIGNMENT_ROLE_REQUIRED_USER_ROLE[assignmentRole]
    if (!assigneeRoles.some((r) => required.includes(r))) {
      throw validationError(`Assignee must hold one of: ${required.join(', ')}`)
    }

    const current = await t.findOne('claim_assignments', { claim_id: claimId, assignment_role: assignmentRole, is_active: true })
    if (current?.assignee_id === assigneeId) {
      throw businessRule('ALREADY_ASSIGNED', `${assignee.full_name} is already assigned to this claim`)
    }
    if (current && !reason) throw validationError('A reason is required when reassigning a claim')
    if (current) {
      await t.updateById('claim_assignments', current.id, { is_active: false, ended_at: new Date() })
    }

    const assignment = await t.insert('claim_assignments', {
      claim_id: claimId,
      assignee_id: assigneeId,
      assignment_role: assignmentRole,
      assigned_by: ctx.actor.id,
      reason: reason || null,
    })
    let updated = await t.updateById('claims', claimId, { [CLAIM_COLUMN[assignmentRole]]: assigneeId })

    if (assignmentRole === 'DOCUMENT_REVIEWER') {
      await t.update(
        'documents',
        { claim_id: claimId, status: 'PENDING_REVIEW', reviewer_id: null },
        { reviewer_id: assigneeId, review_assigned_at: new Date() },
      )
    }

    await recordAudit(t, ctx.actor, {
      action: current ? 'CLAIM_REASSIGNED' : 'CLAIM_ASSIGNED',
      entityType: 'claim_assignment',
      entityId: assignment.id,
      claimId,
      before: current,
      after: assignment,
      metadata: { assignmentRole, reason, previousAssignee: current?.assignee_id || null },
    })

    await notify(ctx, t, {
      recipientIds: [assigneeId],
      claimId,
      type: 'CLAIM_ASSIGNED',
      title: `Claim ${claim.claim_number} assigned to you`,
      message: `You have been assigned as ${assignmentRole.replace('_', ' ').toLowerCase()} for claim ${claim.claim_number}.`,
      link: claimLink(claim, false),
    })

    if (assignmentRole === 'ADJUSTER') {
      await t.update(
        'tasks',
        { claim_id: claimId, task_type: 'ASSIGN_ADJUSTER', status: { in: OPEN_TASK_STATUSES } },
        { status: 'DONE', completed_at: new Date(), completed_by: ctx.actor.id },
      )
      await t.update(
        'tasks',
        { claim_id: claimId, task_type: 'INVESTIGATION', status: { in: OPEN_TASK_STATUSES } },
        { assignee_id: assigneeId },
      )
      if (claim.status === 'ADJUSTER_ASSIGNMENT') {
        await t.insert('tasks', {
          claim_id: claimId,
          title: `Investigate claim ${claim.claim_number}`,
          description: 'Complete the investigation checklist and submit a loss assessment with a reserve recommendation.',
          task_type: 'INVESTIGATION',
          assignee_id: assigneeId,
          assigned_role: ROLES.CLAIMS_ADJUSTER,
          priority: claim.priority,
          is_mandatory: true,
          due_at: hoursFromNow(STATUS_SLA_HOURS.INVESTIGATION),
          created_by: ctx.actor.id,
        })
        updated = await transitionClaim(ctx, t, updated, 'INVESTIGATION', { reason: `Adjuster ${assignee.full_name} assigned` })
      }
    }
    return { assignment, claim: updated }
  })
}

export async function listAssignees(ctx, role) {
  const users = await ctx.db.query(
    `select p.id, p.full_name, p.email, ur.approval_limit
       from public.user_roles ur join public.profiles p on p.id = ur.user_id
      where ur.role_code = $1 and p.is_active
      order by p.full_name`,
    [role],
  )
  const column = { CLAIMS_ADJUSTER: 'assigned_adjuster_id', DOCUMENT_REVIEWER: 'assigned_reviewer_id' }[role] || 'assigned_owner_id'
  const loads = users.length
    ? await ctx.db.query(
        `select ${column} as user_id, count(*)::int as count from public.claims
          where ${column} = any($1) and status = any($2) group by ${column}`,
        [users.map((u) => u.id), [...ACTIVE_STATUSES, 'ON_HOLD']],
      )
    : []
  const loadMap = Object.fromEntries(loads.map((l) => [l.user_id, l.count]))
  return users.map((u) => ({ ...u, active_claims: loadMap[u.id] || 0 }))
}

export async function teamWorkload(ctx) {
  requirePermission(ctx.actor, 'reports.teamMetrics')
  const staff = await ctx.db.query(
    `select p.id, p.full_name, array_agg(ur.role_code order by ur.role_code) as roles
       from public.profiles p join public.user_roles ur on ur.user_id = p.id
      where p.is_active and ur.role_code in ('CLAIMS_OPERATIONS', 'DOCUMENT_REVIEWER', 'CLAIMS_ADJUSTER')
      group by p.id, p.full_name order by p.full_name`,
  )
  const ids = staff.map((s) => s.id)
  if (ids.length === 0) return []
  const active = [...ACTIVE_STATUSES, 'ON_HOLD']
  const [claims, tasks] = await Promise.all([
    ctx.db.query(
      `select u.id as user_id, count(distinct c.id)::int as active_claims,
              count(distinct c.id) filter (where c.priority in ('HIGH', 'URGENT'))::int as high_priority,
              count(distinct c.id) filter (where c.due_date < now())::int as overdue_claims
         from unnest($1::uuid[]) as u(id)
         join public.claims c on (c.assigned_owner_id = u.id or c.assigned_adjuster_id = u.id or c.assigned_reviewer_id = u.id)
        where c.status = any($2)
        group by u.id`,
      [ids, active],
    ),
    ctx.db.query(
      `select assignee_id as user_id, count(*)::int as open_tasks,
              count(*) filter (where due_at < now())::int as overdue_tasks
         from public.tasks where assignee_id = any($1) and status in ('OPEN', 'IN_PROGRESS')
        group by assignee_id`,
      [ids],
    ),
  ])
  const c = Object.fromEntries(claims.map((r) => [r.user_id, r]))
  const tk = Object.fromEntries(tasks.map((r) => [r.user_id, r]))
  return staff.map((s) => ({
    id: s.id,
    full_name: s.full_name,
    roles: s.roles,
    active_claims: c[s.id]?.active_claims || 0,
    high_priority: c[s.id]?.high_priority || 0,
    overdue_claims: c[s.id]?.overdue_claims || 0,
    open_tasks: tk[s.id]?.open_tasks || 0,
    overdue_tasks: tk[s.id]?.overdue_tasks || 0,
  }))
}
