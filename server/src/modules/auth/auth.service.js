import { PRIVACY_NOTICE_VERSION, ROLES } from '../../../../shared/constants.js'
import { permissionsFor, visibleTabs } from '../../../../shared/permissions.js'
import { recordAudit } from '../../services/audit.service.js'
import { limitsForUser } from '../../services/config.service.js'

export async function describeUser(ctx, user) {
  const staff = user.roles.some((r) => r !== ROLES.CLIENT)
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    roles: user.roles,
    // Monetary authority by segment (reserve and settlement), from authority_limits and per-user overrides.
    limits: staff ? await limitsForUser(ctx.db, user.id) : null,
    permissions: permissionsFor(user.roles),
    claimTabs: visibleTabs(user.roles),
  }
}

export async function updateProfile(ctx, patch) {
  const before = await ctx.db.findById('users', ctx.actor.id)
  const update = { updated_by: ctx.actor.id }
  if (patch.fullName !== undefined) update.full_name = patch.fullName
  if (patch.phone !== undefined) update.phone = patch.phone
  return ctx.db.tx(async (t) => {
    const after = await t.updateById('users', ctx.actor.id, update)
    await recordAudit(t, ctx.actor, { action: 'PROFILE_UPDATED', entityType: 'user', entityId: after.id, before, after })
    return after
  })
}

export async function listConsents(ctx) {
  return ctx.db.findMany('consents', { where: { subject_id: ctx.actor.id }, orderBy: [['recorded_at', 'desc']] })
}

/** Records a consent decision (granted or withdrawn) with the notice version shown. */
export async function recordConsent(ctx, { consentType, granted }) {
  return ctx.db.tx(async (t) => {
    if (!granted) {
      await t.update('consents', { subject_id: ctx.actor.id, consent_type: consentType, withdrawn_at: null }, { withdrawn_at: new Date() })
    }
    const row = await t.insert('consents', {
      subject_id: ctx.actor.id,
      consent_type: consentType,
      notice_version: PRIVACY_NOTICE_VERSION,
      granted,
    })
    await recordAudit(t, ctx.actor, {
      action: granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
      entityType: 'consent',
      entityId: row.id,
      metadata: { consentType },
    })
    return row
  })
}

export async function login(ctx, { email, password }) {
  return ctx.authProvider.login(email, password)
}

/** Self-registration always creates a CLIENT account (database trigger) with the privacy-notice consent. */
export async function register(ctx, input) {
  const user = await ctx.authProvider.register(input)
  const actor = { id: user.id, roles: [ROLES.CLIENT], requestId: ctx.requestId, ip: ctx.ip }
  await ctx.db.tx(async (t) => {
    // Registration requires accepting the privacy notice (PRD section 2A.3).
    await t.insert('consents', {
      subject_id: user.id,
      consent_type: 'PRIVACY_NOTICE',
      notice_version: PRIVACY_NOTICE_VERSION,
      granted: true,
    })
    await recordAudit(t, actor, { action: 'CLIENT_REGISTERED', entityType: 'user', entityId: user.id })
  })
  return { id: user.id, email: user.email }
}

export async function forgotPassword(ctx, { email }, resetUrlBase) {
  await ctx.authProvider.requestPasswordReset(email, resetUrlBase)
  // The same answer whether or not the account exists, so emails cannot be enumerated.
  const consoleOnly = ctx.config.EMAIL_ADAPTER === 'console'
  return {
    message: 'If an account exists for this email, password reset instructions have been issued.',
    delivery: consoleOnly ? 'LOGGED_DEV' : ctx.config.EMAIL_ADAPTER === 'disabled' ? 'DISABLED' : 'QUEUED',
    ...(consoleOnly ? { note: 'No email provider is configured: the reset link is written to the server log.' } : {}),
  }
}

export async function resetPassword(ctx, { token, password }) {
  return ctx.authProvider.resetPassword(token, password)
}
