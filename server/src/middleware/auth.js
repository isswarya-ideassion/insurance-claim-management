import { can, hasAnyRole } from '../../../shared/permissions.js'
import { forbidden, unauthorized } from '../utils/errors.js'

export async function loadUserContext(db, identity) {
  const profile = await db.findById('profiles', identity.id)
  if (!profile) throw unauthorized('No profile exists for this account')
  if (!profile.is_active) throw forbidden('This account has been deactivated', 'ACCOUNT_DISABLED')
  const roleRows = await db.findMany('user_roles', { where: { user_id: profile.id } })
  const roles = roleRows.map((r) => r.role_code)
  if (roles.length === 0) throw forbidden('No roles are assigned to this account', 'NO_ROLES')
  const manager = roleRows.find((r) => r.role_code === 'CLAIMS_MANAGER')
  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    phone: profile.phone,
    roles,
    approvalLimit: manager?.approval_limit ?? null,
  }
}

/** Verifies the bearer token, loads profile + roles, and builds req.ctx for services. */
export async function authenticate(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')
  if (!match) throw unauthorized()
  const deps = req.app.locals.deps
  const identity = await deps.authProvider.verifyToken(match[1].trim())
  req.user = await loadUserContext(deps.db, identity)
  req.ctx = {
    ...deps,
    actor: { ...req.user, requestId: req.id, ip: req.ip },
  }
  next()
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) throw unauthorized()
    if (!hasAnyRole(req.user.roles, roles)) throw forbidden(`Requires one of: ${roles.join(', ')}`)
    next()
  }
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) throw unauthorized()
    if (!can(req.user.roles, permission)) throw forbidden(`Missing permission: ${permission}`)
    next()
  }
}
