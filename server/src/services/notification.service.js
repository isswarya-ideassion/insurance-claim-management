import { logger } from '../config/logger.js'

export async function userIdsWithRole(t, roleCode) {
  const rows = await t.query(
    `select ur.user_id from public.user_roles ur join public.users u on u.id = ur.user_id
     where ur.role_code = $1 and u.is_active`,
    [roleCode],
  )
  return rows.map((r) => r.user_id)
}

/**
 * Creates one IN_APP notification per recipient inside the caller's
 * transaction and, when email is requested, one EMAIL row that is handed to the
 * email adapter after commit. EMAIL rows record what the adapter reported
 * (never SENT without provider confirmation). Returns the IN_APP rows.
 */
export async function notify(ctx, t, { recipientIds, claimId = null, type, title, message, link = null, email = true }) {
  const unique = [...new Set((recipientIds || []).filter(Boolean))]
  if (unique.length === 0) return []
  const now = new Date()
  const base = (recipientId) => ({ recipient_id: recipientId, claim_id: claimId, template: type, title, message, link })
  const rows = await t.insert(
    'notifications',
    unique.map((recipientId) => ({ ...base(recipientId), channel: 'IN_APP', status: 'DELIVERED', sent_at: now })),
  )

  if (email && ctx.email.name !== 'disabled') {
    const emailRows = await t.insert(
      'notifications',
      unique.map((recipientId) => ({ ...base(recipientId), channel: 'EMAIL', status: 'PENDING' })),
    )
    t.afterCommit(async () => {
      for (const row of emailRows) {
        try {
          const user = await ctx.db.findById('users', row.recipient_id)
          if (!user?.email) continue
          const result = await ctx.email.send({ to: user.email, subject: title, text: message })
          await ctx.db.updateById('notifications', row.id, {
            status: result.status,
            sent_at: new Date(),
            provider_message_id: result.providerMessageId || null,
          })
        } catch (err) {
          logger.warn('email dispatch failed', { notificationId: row.id, error: err.message })
          await ctx.db.updateById('notifications', row.id, { status: 'FAILED' }).catch(() => {})
        }
      }
    })
  }
  return rows
}

export function claimLink(claim, forCustomer) {
  return forCustomer ? `/customer/claims/${claim.id}` : `/claims/${claim.id}`
}

export function claimRef(claim) {
  return claim.claim_number || 'your draft claim'
}
