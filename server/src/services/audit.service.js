const REDACTED_FIELDS = ['beneficiary_account', 'payout_account_number', 'encrypted_password']

function redact(row) {
  if (!row || typeof row !== 'object') return row ?? null
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = REDACTED_FIELDS.includes(key) && value ? '[REDACTED]' : value
  }
  return out
}

/** Records only the fields that changed between two row snapshots. */
function diff(before, after) {
  if (!before || !after) return { before: redact(before), after: redact(after) }
  const b = {}
  const a = {}
  for (const key of Object.keys(after)) {
    if (key === 'updated_at') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key]
      a[key] = after[key]
    }
  }
  return { before: redact(b), after: redact(a) }
}

/**
 * Appends an immutable audit record. Must be called with the same transaction
 * handle as the change it describes so both commit or roll back together.
 */
export async function recordAudit(t, actor, { action, entityType, entityId = null, claimId = null, before, after, metadata }) {
  const changes = diff(before, after)
  return t.insert('audit_logs', {
    actor_id: actor?.id || null,
    actor_roles: actor?.roles || [],
    action,
    entity_type: entityType,
    entity_id: entityId,
    claim_id: claimId,
    before_data: changes.before,
    after_data: changes.after,
    metadata: metadata || {},
    request_id: actor?.requestId || null,
    ip_address: actor?.ip || null,
  })
}
