import { logger } from '../config/logger.js'

/**
 * Email delivery abstraction. send() resolves to { status, providerMessageId }.
 * status is SENT only when a real provider confirms acceptance; the console
 * adapter reports LOGGED_DEV because nothing is delivered.
 *
 * To add a real provider, implement the same send() contract and register it
 * in createEmailService.
 */
export function createEmailService(config) {
  if (config.EMAIL_ADAPTER === 'disabled') {
    return { name: 'disabled', send: async () => ({ status: 'NOT_REQUESTED', providerMessageId: null }) }
  }
  return {
    name: 'console',
    async send({ to, subject, text }) {
      logger.info('[DEV EMAIL — NOT DELIVERED]', { from: config.EMAIL_FROM, to, subject, text })
      return { status: 'LOGGED_DEV', providerMessageId: null }
    },
  }
}
