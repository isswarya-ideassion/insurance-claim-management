import { logger } from '../config/logger.js'

export async function userIdsWithRole(t, roleCode) {
  const rows = await t.query(
    `select ur.user_id from public.user_roles ur join public.profiles p on p.id = ur.user_id
     where ur.role_code = $1 and p.is_active`,
    [roleCode],
  )
  return rows.map((r) => r.user_id)
}

/**
 * Creates in-app notification records inside the caller's transaction and,
 * after commit, hands them to the email adapter. email_status reflects what the
 * adapter actually reported (never SENT without provider confirmation).
 */
export async function notify(ctx, t, { recipientIds, claimId = null, type, title, message, link = null, email = true }) {
  const unique = [...new Set((recipientIds || []).filter(Boolean))]
  if (unique.length === 0) return []
  const sendEmail = email && ctx.email.name !== 'disabled'
  const rows = await t.insert(
    'notifications',
    unique.map((recipientId) => ({
      recipient_id: recipientId,
      claim_id: claimId,
      type,
      title,
      message,
      link,
      email_status: sendEmail ? 'PENDING' : 'NOT_REQUESTED',
    })),
  )

  if (sendEmail) {
    t.afterCommit(async () => {
      for (const row of rows) {
        try {
          const profile = await ctx.db.findById('profiles', row.recipient_id)
          if (!profile?.email) continue
          const result = await ctx.email.send({ to: profile.email, subject: title, text: message })
          await ctx.db.updateById('notifications', row.id, {
            email_status: result.status,
            email_provider_message_id: result.providerMessageId || null,
          })
        } catch (err) {
          logger.warn('email dispatch failed', { notificationId: row.id, error: err.message })
          await ctx.db.updateById('notifications', row.id, { email_status: 'FAILED' }).catch(() => {})
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
