import { ROLES, OPEN_TASK_STATUSES } from '../../../../shared/constants.js'
import { hasAnyRole } from '../../../../shared/permissions.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { claimScope, loadAccessibleClaim, requirePermission, requireStaffView, requireNotOwnClaim } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { notify, userIdsWithRole } from '../../services/notification.service.js'
import { profileMap, nameOf } from '../../services/presenters.js'
import { logger } from '../../config/logger.js'

const TEAM_ROLES = [ROLES.CLAIMS_OPERATIONS, ROLES.CLAIMS_MANAGER, ROLES.AUDITOR]

async function decorate(db, tasks) {
  const claimIds = [...new Set(tasks.map((t) => t.claim_id).filter(Boolean))]
  const claims = claimIds.length
    ? await db.findMany('claims', { where: { id: { in: claimIds } }, columns: ['id', 'claim_number', 'status'] })
    : []
  const claimMap = Object.fromEntries(claims.map((c) => [c.id, c]))
  const names = await profileMap(db, tasks.flatMap((t) => [t.assignee_id, t.created_by, t.completed_by]))
  const now = Date.now()
  return tasks.map((t) => ({
    ...t,
    claim_number: claimMap[t.claim_id]?.claim_number || null,
    claim_status: claimMap[t.claim_id]?.status || null,
    assignee_name: nameOf(names, t.assignee_id),
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
    if (!hasAnyRole(ctx.actor.roles, TEAM_ROLES)) throw forbidden('Team task view requires operations or manager access')
    const scope = await claimScope(ctx.db, ctx.actor)
    const ids = (await ctx.db.findMany('claims', { where: scope, columns: ['id'] })).map((c) => c.id)
    filters.push({ $or: [{ claim_id: { in: ids } }, { claim_id: null }] })
  } else {
    const staffRoles = ctx.actor.roles.filter((r) => r !== ROLES.CUSTOMER)
    filters.push({ $or: [{ assignee_id: ctx.actor.id }, { $and: [{ assignee_id: null }, { assigned_role: { in: staffRoles } }] }] })
  }
  if (query.status?.length) filters.push({ status: { in: query.status } })
  if (query.overdue === 'true') filters.push({ status: { in: OPEN_TASK_STATUSES }, due_at: { lt: new Date() } })

  const where = { $and: filters }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('tasks', { where, orderBy: [['due_at', 'asc'], ['created_at', 'desc']], ...toOffset(query) }),
    ctx.db.count('tasks', where),
  ])
  return { items: await decorate(ctx.db, rows), meta: pageMeta(query, total) }
}

async function validateAssignee(t, assigneeId) {
  if (!assigneeId) return
  const roles = (await t.findMany('user_roles', { where: { user_id: assigneeId } })).map((r) => r.role_code)
  if (!roles.some((r) => r !== ROLES.CUSTOMER)) throw validationError('Tasks can only be assigned to staff members')
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
    await validateAssignee(t, input.assigneeId)
    const task = await t.insert('tasks', {
      claim_id: input.claimId || null,
      title: input.title,
      description: input.description || null,
      task_type: input.taskType,
      priority: input.priority,
      is_mandatory: input.isMandatory,
      assignee_id: input.assigneeId || null,
      assigned_role: input.assignedRole || null,
      due_at: input.dueAt || null,
      created_by: ctx.actor.id,
    })
    await recordAudit(t, ctx.actor, { action: 'TASK_CREATED', entityType: 'task', entityId: task.id, claimId: task.claim_id, after: task })
    if (task.assignee_id && task.assignee_id !== ctx.actor.id) {
      await notify(ctx, t, {
        recipientIds: [task.assignee_id],
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
    const supervisor = hasAnyRole(ctx.actor.roles, [ROLES.CLAIMS_OPERATIONS, ROLES.CLAIMS_MANAGER])
    const involved =
      task.assignee_id === ctx.actor.id ||
      task.created_by === ctx.actor.id ||
      (!task.assignee_id && task.assigned_role && ctx.actor.roles.includes(task.assigned_role))
    if (!supervisor && !involved) throw forbidden('Only the assignee, creator, operations or managers can update this task')
    if (!OPEN_TASK_STATUSES.includes(task.status)) throw businessRule('TASK_CLOSED', 'Completed or cancelled tasks cannot be changed')
    if (input.status === 'CANCELLED' && task.is_mandatory && !ctx.actor.roles.includes(ROLES.CLAIMS_MANAGER)) {
      throw forbidden('Only a claims manager can cancel a mandatory task')
    }
    if (input.assigneeId !== undefined) await validateAssignee(t, input.assigneeId)

    const patch = {}
    if (input.status) patch.status = input.status
    if (input.status === 'DONE' || input.status === 'CANCELLED') {
      patch.completed_at = new Date()
      patch.completed_by = ctx.actor.id
    }
    if (input.assigneeId !== undefined) patch.assignee_id = input.assigneeId
    if (input.dueAt !== undefined) {
      patch.due_at = input.dueAt
      patch.overdue_notified_at = null
    }
    if (input.priority) patch.priority = input.priority
    const updated = await t.updateById('tasks', id, patch)
    await recordAudit(t, ctx.actor, { action: 'TASK_UPDATED', entityType: 'task', entityId: id, claimId: task.claim_id, before: task, after: updated })
    if (input.assigneeId && input.assigneeId !== ctx.actor.id && input.assigneeId !== task.assignee_id) {
      await notify(ctx, t, {
        recipientIds: [input.assigneeId],
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

/** Notifies assignees (or role holders) about overdue tasks once per due date. */
export async function runOverdueSweep(deps) {
  const ctx = { ...deps, actor: { id: null, roles: ['SYSTEM'], requestId: 'overdue-sweep' } }
  const overdue = await deps.db.findMany('tasks', {
    where: { status: { in: OPEN_TASK_STATUSES }, due_at: { lt: new Date() }, overdue_notified_at: null },
    limit: 500,
  })
  let notified = 0
  for (const task of overdue) {
    await deps.db.tx(async (t) => {
      const recipients = task.assignee_id ? [task.assignee_id] : task.assigned_role ? await userIdsWithRole(t, task.assigned_role) : []
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
  if (overdue.length) logger.info('overdue sweep complete', { overdue: overdue.length, notified })
  return { overdue: overdue.length, notified }
}
