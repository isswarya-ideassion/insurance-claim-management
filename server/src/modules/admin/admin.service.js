import { ROLES } from '../../../../shared/constants.js'
import { businessRule, forbidden, notFound } from '../../utils/errors.js'
import { escapeLike } from '../../db/queryBuilder.js'
import { pageMeta, toOffset } from '../../utils/http.js'
import { requirePermission } from '../../services/access.service.js'
import { recordAudit } from '../../services/audit.service.js'
import { runSlaSweep } from '../../services/sla.service.js'
import { runOverdueSweep } from '../tasks/tasks.service.js'

function preventSelfChange(ctx, userId) {
  if (userId === ctx.actor.id) {
    throw forbidden('You cannot change your own roles, limits or status', 'SELF_ESCALATION_FORBIDDEN')
  }
}

/** Per-user monetary authority overrides (ABAC attributes); null keeps the role default from authority_limits. */
async function saveAttributes(t, ctx, userId, { reserveLimit, settlementLimit, region, teamId }) {
  if ([reserveLimit, settlementLimit, region, teamId].every((v) => v === undefined)) return null
  const existing = await t.findOne('user_attributes', { user_id: userId })
  const values = { updated_by: ctx.actor.id }
  if (reserveLimit !== undefined) values.reserve_limit = reserveLimit
  if (settlementLimit !== undefined) values.settlement_limit = settlementLimit
  if (region !== undefined) values.region = region
  if (teamId !== undefined) values.team_id = teamId
  const row = existing
    ? (await t.update('user_attributes', { user_id: userId }, values))[0]
    : await t.insert('user_attributes', { user_id: userId, ...values })
  await recordAudit(t, ctx.actor, { action: 'USER_ATTRIBUTES_UPDATED', entityType: 'user_attributes', entityId: userId, before: existing, after: row })
  return row
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
    ctx.db.findMany('users', { where, orderBy: [['full_name', 'asc']], ...toOffset(query) }),
    ctx.db.count('users', where),
  ])
  const ids = rows.map((r) => r.id)
  const [roles, attributes] = ids.length
    ? await Promise.all([
        ctx.db.findMany('user_roles', { where: { user_id: { in: ids } } }),
        ctx.db.findMany('user_attributes', { where: { user_id: { in: ids } } }),
      ])
    : [[], []]
  const attrMap = Object.fromEntries(attributes.map((a) => [a.user_id, a]))
  return {
    items: rows.map((p) => ({
      ...p,
      roles: roles.filter((r) => r.user_id === p.id).map((r) => ({ roleCode: r.role_code, grantedAt: r.granted_at })),
      attributes: attrMap[p.id] || null,
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
  const staff = input.roles.some((r) => r !== ROLES.CLIENT)
  const created = await ctx.authProvider.createUser({
    email: input.email,
    password: input.password,
    fullName: input.fullName,
    phone: input.phone,
    staff,
  })
  return ctx.db.tx(async (t) => {
    const user = await t.findById('users', created.id)
    if (!user) throw businessRule('USER_MISSING', 'The authentication user was created but no user record was provisioned')
    for (const roleCode of input.roles) {
      await t.query(
        `insert into public.user_roles (user_id, role_code, granted_by) values ($1, $2, $3)
         on conflict (user_id, role_code) do update set granted_by = excluded.granted_by`,
        [created.id, roleCode, ctx.actor.id],
      )
    }
    await saveAttributes(t, ctx, created.id, input)
    await recordAudit(t, ctx.actor, {
      action: 'USER_CREATED',
      entityType: 'user',
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
  return ctx.db.tx(async (t) => {
    const user = await t.findById('users', userId)
    if (!user) throw notFound('User not found')
    const before = await t.findOne('user_roles', { user_id: userId, role_code: grant.roleCode })
    const [row] = await t.query(
      `insert into public.user_roles (user_id, role_code, granted_by) values ($1, $2, $3)
       on conflict (user_id, role_code) do update set granted_by = excluded.granted_by
       returning *`,
      [userId, grant.roleCode, ctx.actor.id],
    )
    await saveAttributes(t, ctx, userId, grant)
    await recordAudit(t, ctx.actor, { action: before ? 'ROLE_UPDATED' : 'ROLE_GRANTED', entityType: 'user_role', entityId: row.id, before, after: row })
    return row
  })
}

export async function updateAttributes(ctx, userId, input) {
  requirePermission(ctx.actor, 'admin.users')
  preventSelfChange(ctx, userId)
  return ctx.db.tx(async (t) => {
    if (!(await t.findById('users', userId))) throw notFound('User not found')
    return saveAttributes(t, ctx, userId, input)
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
    const before = await t.findById('users', userId)
    if (!before) throw notFound('User not found')
    const after = await t.updateById('users', userId, { is_active: isActive, updated_by: ctx.actor.id })
    await recordAudit(t, ctx.actor, { action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', entityType: 'user', entityId: userId, before, after })
    return after
  })
}

export async function triggerOverdueSweep(ctx) {
  requirePermission(ctx.actor, 'admin.jobs')
  const tasks = await runOverdueSweep(ctx)
  const sla = await runSlaSweep(ctx)
  const result = { ...tasks, sla }
  await recordAudit(ctx.db, ctx.actor, { action: 'OVERDUE_SWEEP_TRIGGERED', entityType: 'job', metadata: result })
  return result
}

export function systemInfo(ctx) {
  requirePermission(ctx.actor, 'admin.users')
  return {
    database: 'PostgreSQL',
    demoData: ctx.config.demoData,
    environment: ctx.config.NODE_ENV,
    emailAdapter: ctx.email.name,
    paymentAdapter: ctx.payments.name,
    paymentsSimulated: ctx.payments.isSimulated,
    storage: ctx.storage.kind,
    fieldEncryption: 'AES-256-GCM',
  }
}
