import { createHash } from 'node:crypto'

/**
 * SIMULATED PAYMENT ADAPTER — FOR THE MVP ONLY. It never contacts a bank or
 * moves money. Every reference it returns is prefixed "SIM-" and every payment
 * it handles is stored with is_simulated = true.
 *
 * Deterministic outcomes so failure handling can be demonstrated:
 *   - beneficiary account ending in 0000 -> FAILED (ACCOUNT_CLOSED)
 *   - beneficiary account ending in 9999 -> FAILED (BENEFICIARY_NAME_MISMATCH)
 *   - amount above 1,000,000             -> FAILED (LIMIT_EXCEEDED)
 *   - otherwise                          -> SUCCEEDED
 */
export function createSimulatedPaymentAdapter() {
  return {
    name: 'SIMULATED',
    isSimulated: true,
    async initiateTransfer({ amount, beneficiaryAccount, idempotencyKey }) {
      const account = String(beneficiaryAccount || '')
      const ref = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12).toUpperCase()
      const base = { provider: 'SIMULATED', simulated: true, processedAt: new Date().toISOString() }
      if (account.endsWith('0000')) {
        return { ...base, status: 'FAILED', failureCode: 'ACCOUNT_CLOSED', failureReason: 'Simulated: beneficiary account is closed' }
      }
      if (account.endsWith('9999')) {
        return {
          ...base,
          status: 'FAILED',
          failureCode: 'BENEFICIARY_NAME_MISMATCH',
          failureReason: 'Simulated: beneficiary name does not match account holder',
        }
      }
      if (Number(amount) > 1_000_000) {
        return { ...base, status: 'FAILED', failureCode: 'LIMIT_EXCEEDED', failureReason: 'Simulated: amount exceeds single-transfer limit' }
      }
      return { ...base, status: 'SUCCEEDED', providerReference: `SIM-TXN-${ref}` }
    },
  }
}
