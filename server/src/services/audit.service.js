const REDACTED_FIELDS = ['bank_details_encrypted', 'bank_details_hash', 'contact_encrypted', 'encrypted_password']

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
    if (key === 'updated_at' || key === 'version') continue
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key]
      a[key] = after[key]
    }
  }
  return { before: redact(b), after: redact(a) }
}

/**
 * Appends an audit record (hash-chained by the database). Must be called with
 * the same transaction handle as the change it describes so both commit or
 * roll back together. actor.type is USER, AGENT (Claude agent service) or SYSTEM.
 */
export async function recordAudit(t, actor, { action, entityType, entityId = null, claimId = null, before, after, metadata }) {
  const changes = diff(before, after)
  return t.insert('audit_logs', {
    actor_id: actor?.id || null,
    actor_type: actor?.type || (actor?.id ? 'USER' : 'SYSTEM'),
    actor_roles: actor?.roles || [],
    action,
    entity_type: entityType,
    entity_id: entityId,
    claim_id: claimId,
    before: changes.before,
    after: changes.after,
    metadata: metadata || {},
    request_id: actor?.requestId || null,
    ip: actor?.ip || null,
  })
}
