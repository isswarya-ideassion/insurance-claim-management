import { ROLES, OPEN_TASK_STATUSES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { claimScope, loadAccessibleClaim, requirePermission, requireStaffView, requireNotOwnClaim } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { getSegmentConfig } from '../../services/config.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { logger } from '../../config/logger.js'

const TEAM_ROLES = [ROLES.CLAIMS_OPS_MANAGER, ROLES.OPS_MANAGER, ROLES.COMPLIANCE_SECURITY]

async function decorate(db, tasks) {
  const claimIds = [...new Set(tasks.map((t) => t.claim_id).filter(Boolean))]
  const claims = claimIds.length
    ? await db.findMany('claims', { where: { id: { in: claimIds } }, columns: ['id', 'claim_number', 'status'] })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const names = await profileMap(db, tasks.flatMap((t) => [t.owner_user_id, t.created_by, t.completed_by]))
  const now = Date.now()
  return tasks.map((t) => ({
    ...t,
    claim_number: claimMap[t.claim_id]?.claim_number || null,
    claim_status: claimMap[t.claim_id]?.status || null,
    owner_name: nameOf(names, t.owner_user_id),
    created_by_name: nameOf(names, t.created_by),
    completed_by_name: nameOf(names, t.completed_by),
    is_overdue: Boolean(t.due_at && OPEN_TASK_STATUSES.includes(t.status) && new Date(t.due_at).getTime() < now),
  }))
}

export async function listTasks(ctx, query) {
  requirePermission(ctx.actor, 'claims.viewQueue')
  const filters = []
  if (query.claimId) {
    const claim = await loadAccessibleClaim(ctx.db, ctx.actor, query.claimId)
    requireStaffView(ctx.actor, claim)
    filters.push({ claim_id: query.claimId })
  } else if (query.view === 'team') {
    if (!hasAnyRole(ctx.actor.roles, TEAM_ROLES)) throw forbidden('Team task view requires a Claims Manager, Claims Operations Manager or Compliance & Security')
    const scope = await claimScope(ctx.db, ctx.actor)
    const ids = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
    filters.push({ $or: [{ claim_id: { in: ids } }, { claim_id: null }] })
  } else {
    // My work: tasks I own plus unclaimed tasks in the queues of my roles.
    const staffRoles = ctx.actor.roles.filter((r) => r !== ROLES.CLIENT)
    filters.push({ $or: [{ owner_user_id: ctx.actor.id }, { $and: [{ owner_user_id: null }, { owner_role: { in: staffRoles } }] }] })
  }
  if (query.status?.length) filters.push({ status: { in: query.status } })
  if (query.overdue === 'true') filters.push({ status: { in: OPEN_TASK_STATUSES }, due_at: { lt: new Date() } })
  if (query.unclaimed === 'true') filters.push({ owner_user_id: null })

  const where = { $and: filters }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('tasks', { where, orderBy: [['due_at', 'asc'], ['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('tasks', where),
  ])
  return { items: await decorate(ctx.db, rows), meta: pageMeta(query, total) }
}

async function validateOwner(t, ownerId) {
  if (!ownerId) return
  const roles = (await t.findMany('user_roles', { where: { user_id: ownerId } })).map((r) => r.role_code)
  if (!roles.some((r) => r !== ROLES.CLIENT)) throw validationError('Tasks can only be assigned to staff members')
}

export async function createTask(ctx, input) {
  requirePermission(ctx.actor, 'tasks.create')
  return ctx.db.tx(async (t) => {
    let claim = null
    if (input.claimId) {
      claim = await loadAccessibleClaim(t, ctx.actor, input.claimId)
      requireStaffView(ctx.actor, claim)
      requireNotOwnClaim(ctx.actor, claim)
      if (['CLOSED', 'WITHDRAWN'].includes(claim.status)) throw businessRule('INVALID_STAGE', 'Tasks cannot be added to closed claims')
    }
    if (!input.ownerUserId && !input.ownerRole) throw validationError('A task needs a named owner or a team queue (owner role)')
    await validateOwner(t, input.ownerUserId)
    const task = await t.insert('tasks', {
      claim_id: input.claimId || null,
      title: input.title,
      description: input.description || null,
      type: input.type,
      priority: input.priority,
      blocking: input.blocking,
      owner_user_id: input.ownerUserId || null,
      owner_role: input.ownerRole || null,
      claimed_at: input.ownerUserId ? new Date() : null,
      source_stage: claim?.stage || null,
      due_at: input.dueAt || null,
      created_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'TASK_CREATED', entityType: 'task', entityId: task.id, claimId: task.claim_id, after: task })
    if (task.owner_user_id && task.owner_user_id !== ctx.actor.id) {
      await notify(ctx, t, {
        recipientIds: [task.owner_user_id],
        claimId: task.claim_id,
        type: 'TASK_ASSIGNED',
        title: `New task: ${task.title}`,
        message: claim ? `Task on claim ${claim.claim_number}: ${task.title}` : task.title,
        link: claim ? `/claims/${claim.id}?tab=tasks` : '/tasks',
        email: false,
      })
    }
    return task
  })
}

export async function updateTask(ctx, id, input) {
  requirePermission(ctx.actor, 'tasks.update')
  return ctx.db.tx(async (t) => {
    const task = await t.findOne('tasks', { id }, { forUpdate: true })
    if (!task) throw notFound('Task not found')
    if (task.claim_id) {
      const claim = await loadAccessibleClaim(t, ctx.actor, task.claim_id)
      requireNotOwnClaim(ctx.actor, claim)
    }
    const supervisor = ctx.actor.roles.some((r) => [ROLES.OPS_MANAGER, ROLES.CLAIMS_OPS_MANAGER].includes(r))
    const queueMember = !task.owner_user_id && task.owner_role && ctx.actor.roles.includes(task.owner_role)
    const involved = task.owner_user_id === ctx.actor.id || task.created_by === ctx.actor.id || queueMember
    if (!supervisor && !involved) throw forbidden('Only the owner, creator, queue members or managers can update this task')
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw businessRule('TASK_CLOSED', 'Completed or cancelled tasks cannot be changed')
    if (input.status === 'CANCELLED' && task.blocking && !supervisor) {
      throw forbidden('Only a Claims Manager or Claims Operations Manager can cancel a blocking task')
    }
    if (input.ownerUserId !== undefined) await validateOwner(t, input.ownerUserId)

    const patch = {}
    if (input.status) patch.status = input.status
    if (input.status === 'DONE' || input.status === 'CANCELLED') {
      patch.completed_at = new Date()
      patch.completed_by = ctx.actor.id
    }
    // Work needs a named person: starting a queue task claims it (PRD FR-X2).
    if (input.status === 'IN_PROGRESS' && !task.owner_user_id && input.ownerUserId === undefined) {
      patch.owner_user_id = ctx.actor.id
      patch.claimed_at = new Date()
    }
    if (input.ownerUserId !== undefined) {
      patch.owner_user_id = input.ownerUserId
      patch.claimed_at = input.ownerUserId ? new Date() : null
    }
    if (input.dueAt !== undefined) {
      patch.due_at = input.dueAt
      patch.overdue_notified_at = null
    }
    if (input.priority) patch.priority = input.priority
    const updated = await t.updateById('tasks', id, patch)
    await recordAudit(t, ctx.actor, { action: 'TASK_UPDATED', entityType: 'task', entityId: id, claimId: task.claim_id, before: task, after: updated })
    if (input.ownerUserId && input.ownerUserId !== ctx.actor.id && input.ownerUserId !== task.owner_user_id) {
      await notify(ctx, t, {
        recipientIds: [input.ownerUserId],
        claimId: task.claim_id,
        type: 'TASK_ASSIGNED',
        title: `Task assigned: ${task.title}`,
        message: task.title,
        link: task.claim_id ? `/claims/${task.claim_id}?tab=tasks` : '/tasks',
        email: false,
      })
    }
    return (await decorate(t, [updated]))[0]
  })
}

/**
 * Notifies owners (or queue members) about overdue tasks once per due date,
 * and escalates queue tasks nobody has claimed within the configured wait to
 * the Claims Managers (PRD FR-X2).
 */
export async function runOverdueSweep(deps) {
  const ctx = { ...deps, actor: { id: null, roles: ['SYSTEM'], requestId: 'overdue-sweep' } }
  const overdue = await deps.db.findMany('tasks', {
    where: { status: { in: OPEN_TASK_STATUSES }, due_at: { lt: new Date() }, overdue_notified_at: null },
    limit: 500,
  })
  let notified = 0
  for (const task of overdue) {
    await deps.db.tx(async (t) => {
      const recipients = task.owner_user_id ? [task.owner_user_id] : task.owner_role ? await userIdsWithRole(t, task.owner_role) : []
      const claim = task.claim_id ? await t.findById('claims', task.claim_id) : null
      await notify(ctx, t, {
        recipientIds: recipients,
        claimId: task.claim_id,
        type: 'TASK_OVERDUE',
        title: `Overdue task: ${task.title}`,
        message: claim ? `The task on claim ${claim.claim_number} was due ${new Date(task.due_at).toUTCString()}.` : `Task was due ${new Date(task.due_at).toUTCString()}.`,
        link: task.claim_id ? `/claims/${task.claim_id}?tab=tasks` : '/tasks',
      })
      await t.updateById('tasks', task.id, { overdue_notified_at: new Date() })
      if (recipients.length) notified += 1
    })
  }

  const unclaimed = await deps.db.query(
    `select t.*, coalesce(c.segment, 'PERSONAL') as claim_segment, c.claim_number
       from public.tasks t left join public.claims c on c.id = t.claim_id
      where t.status = 'OPEN' and t.owner_user_id is null and t.escalated_at is null
      order by t.created_at limit 500`,
  )
  let escalated = 0
  const waits = {}
  for (const task of unclaimed) {
    waits[task.claim_segment] ??= Number(await getSegmentConfig(deps.db, task.claim_segment, 'unclaimed_task_escalation_hours'))
    if (Date.now() - new Date(task.created_at).getTime() < waits[task.claim_segment] * 3600_000) continue
    await deps.db.tx(async (t) => {
      await t.updateById('tasks', task.id, { escalated_at: new Date() })
      await notify(ctx, t, {
        recipientIds: await userIdsWithRole(t, ROLES.OPS_MANAGER),
        claimId: task.claim_id,
        type: 'TASK_OVERDUE',
        title: `Unclaimed task: ${task.title}`,
        message: `Nobody in the ${String(task.owner_role || 'team').replace(/_/g, ' ').toLowerCase()} queue has claimed this task${task.claim_number ? ` on claim ${task.claim_number}` : ''}.`,
        link: task.claim_id ? `/claims/${task.claim_id}?tab=tasks` : '/tasks',
        email: false,
      })
      escalated += 1
    })
  }
  if (overdue.length || escalated) logger.info('task sweep complete', { overdue: overdue.length, notified, escalated })
  return { overdue: overdue.length, notified, unclaimedEscalated: escalated }
}
