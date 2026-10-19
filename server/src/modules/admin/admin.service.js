import { ROLES } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound, validationError } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { runOverdueSweep } from '../tasks/tasks.service.js'

function preventSelfChange(ctx, userId) {
  if (userId === ctx.actor.id) {
    throw forbidden('Administrators cannot change their own roles or status', 'SELF_ESCALATION_FORBIDDEN')
  }
}

function validateGrant({ roleCode, approvalLimit }) {
  if (roleCode === ROLES.CLAIMS_MANAGER && (approvalLimit == null || approvalLimit <= 0)) {
    throw validationError('Claims managers need a positive approval limit')
  }
  if (roleCode !== ROLES.CLAIMS_MANAGER && approvalLimit != null) {
    throw validationError('Approval limits only apply to the CLAIMS_MANAGER role')
  }
}

export async function listUsers(ctx, query) {
  requirePermission(ctx.actor, 'admin.users')
  const where = {}
  if (query.search) {
    const term = `%${escapeLike(query.search)}%`
    where.$or = [{ full_name: { ilike: term } }, { email: { ilike: term } }]
  }
  if (query.role) {
    const holders = await ctx.db.findMany('user_roles', { where: { role_code: query.role }, columns: ['user_id'] })
    where.id = { in: holders.map((h) => h.user_id) }
  }
  const [rows, total] = await Promise.all([
    ctx.db.findMany('profiles', { where, orderBy: [['full_name', 'asc']], ...toOffset(query) }),
    ctx.db.count('profiles', where),
  ])
  const roles = rows.length ? await ctx.db.findMany('user_roles', { where: { user_id: { in: rows.map((r) => r.id) } } }) : []
  return {
    items: rows.map((p) => ({
      ...p,
      roles: roles.filter((r) => r.user_id === p.id).map((r) => ({ roleCode: r.role_code, approvalLimit: r.approval_limit, grantedAt: r.granted_at })),
    })),
    meta: pageMeta(query, total),
  }
}

export async function listRoles(ctx) {
  requirePermission(ctx.actor, 'admin.users')
  return ctx.db.findMany('roles', { orderBy: [['is_staff', 'asc'], ['name', 'asc']] })
}

export async function createUser(ctx, input) {
  requirePermission(ctx.actor, 'admin.users')
  input.roles.forEach(validateGrant)
  const staff = input.roles.some((r) => r.roleCode !== ROLES.CUSTOMER)
  const created = await ctx.authProvider.createUser({
    email: input.email,
    password: input.password,
    fullName: input.fullName,
    phone: input.phone,
    staff,
  })
  return ctx.db.tx(async (t) => {
    const profile = await t.findById('profiles', created.id)
    if (!profile) throw businessRule('PROFILE_MISSING', 'The authentication user was created but no profile was provisioned')
    for (const grant of input.roles) {
      await t.query(
        `insert into public.user_roles (user_id, role_code, approval_limit, granted_by) values ($1, $2, $3, $4)
         on conflict (user_id, role_code) do update set approval_limit = excluded.approval_limit, granted_by = excluded.granted_by`,
        [created.id, grant.roleCode, grant.approvalLimit ?? null, ctx.actor.id],
      )
    }
    await recordAudit(t, ctx.actor, {
      action: 'USER_CREATED',
      entityType: 'profile',
      entityId: created.id,
      after: { email: input.email, full_name: input.fullName },
      metadata: { roles: input.roles },
    })
    return { id: created.id, email: created.email }
  })
}

export async function grantRole(ctx, userId, grant) {
  requirePermission(ctx.actor, 'admin.users')
  preventSelfChange(ctx, userId)
  validateGrant(grant)
  return ctx.db.tx(async (t) => {
    const profile = await t.findById('profiles', userId)
    if (!profile) throw notFound('User not found')
    const before = await t.findOne('user_roles', { user_id: userId, role_code: grant.roleCode })
    const [row] = await t.query(
      `insert into public.user_roles (user_id, role_code, approval_limit, granted_by) values ($1, $2, $3, $4)
       on conflict (user_id, role_code) do update set approval_limit = excluded.approval_limit, granted_by = excluded.granted_by
       returning *`,
      [userId, grant.roleCode, grant.approvalLimit ?? null, ctx.actor.id],
    )
    await recordAudit(t, ctx.actor, { action: before ? 'ROLE_UPDATED' : 'ROLE_GRANTED', entityType: 'user_role', entityId: row.id, before, after: row })
    return row
  })
}

export async function revokeRole(ctx, userId, roleCode) {
  requirePermission(ctx.actor, 'admin.users')
  preventSelfChange(ctx, userId)
  return ctx.db.tx(async (t) => {
    const existing = await t.findOne('user_roles', { user_id: userId, role_code: roleCode })
    if (!existing) throw notFound('Role grant not found')
    await t.remove('user_roles', { id: existing.id })
    await recordAudit(t, ctx.actor, { action: 'ROLE_REVOKED', entityType: 'user_role', entityId: existing.id, before: existing })
    return { revoked: true }
  })
}

export async function setUserActive(ctx, userId, { isActive }) {
  requirePermission(ctx.actor, 'admin.users')
  preventSelfChange(ctx, userId)
  return ctx.db.tx(async (t) => {
    const before = await t.findById('profiles', userId)
    if (!before) throw notFound('User not found')
    const after = await t.updateById('profiles', userId, { is_active: isActive })
    await recordAudit(t, ctx.actor, { action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', entityType: 'profile', entityId: userId, before, after })
    return after
  })
}

export async function triggerOverdueSweep(ctx) {
  requirePermission(ctx.actor, 'admin.jobs')
  const result = await runOverdueSweep(ctx)
  await recordAudit(ctx.db, ctx.actor, { action: 'OVERDUE_SWEEP_TRIGGERED', entityType: 'job', metadata: result })
  return result
}

export function systemInfo(ctx) {
  requirePermission(ctx.actor, 'admin.users')
  return {
    dataMode: ctx.config.DATA_MODE,
    environment: ctx.config.NODE_ENV,
    emailAdapter: ctx.email.name,
    paymentAdapter: ctx.payments.name,
    paymentsSimulated: ctx.payments.isSimulated,
    storage: ctx.storage.kind,
  }
}
