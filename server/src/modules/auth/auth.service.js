import { permissionsFor, visibleTabs } from '../../../../shared/permissions.js'
import { AppError } from '../../utils/errors.js'
import { recordAudit } from '../../services/audit.service.js'

function requireMockProvider(ctx) {
  if (ctx.authProvider.mode !== 'mock') {
    throw new AppError(404, 'MOCK_AUTH_DISABLED', 'Mock authentication is only available when the server runs in mock mode')
  }
}

export function describeUser(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    roles: user.roles,
    approvalLimit: user.approvalLimit,
    permissions: permissionsFor(user.roles),
    claimTabs: visibleTabs(user.roles),
  }
}

export async function updateProfile(ctx, patch) {
  const before = await ctx.db.findById('profiles', ctx.actor.id)
  const update = {}
  if (patch.fullName !== undefined) update.full_name = patch.fullName
  if (patch.phone !== undefined) update.phone = patch.phone
  return ctx.db.tx(async (t) => {
    const after = await t.updateById('profiles', ctx.actor.id, update)
    await recordAudit(t, ctx.actor, { action: 'PROFILE_UPDATED', entityType: 'profile', entityId: after.id, before, after })
    return after
  })
}

export async function mockLogin(ctx, { email, password }) {
  requireMockProvider(ctx)
  return ctx.authProvider.login(email, password)
}

export async function mockRegister(ctx, input) {
  requireMockProvider(ctx)
  const user = await ctx.authProvider.register(input)
  await ctx.db.tx((t) =>
    recordAudit(t, { id: user.id, roles: ['CUSTOMER'], requestId: ctx.requestId, ip: ctx.ip }, {
      action: 'CUSTOMER_REGISTERED',
      entityType: 'profile',
      entityId: user.id,
    }),
  )
  return { id: user.id, email: user.email }
}

export async function mockForgotPassword(ctx, { email }, resetUrlBase) {
  requireMockProvider(ctx)
  const result = await ctx.authProvider.requestPasswordReset(email, resetUrlBase)
  return {
    message: 'If an account exists for this email, password reset instructions have been issued.',
    delivery: result.delivery === 'NOT_SENT' ? 'LOGGED_DEV' : result.delivery,
    note: 'Mock mode: no email is delivered. The reset link is written to the server console.',
  }
}

export async function mockResetPassword(ctx, { token, password }) {
  requireMockProvider(ctx)
  return ctx.authProvider.resetPassword(token, password)
}
