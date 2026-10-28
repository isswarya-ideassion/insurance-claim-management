// Tables the repository may address, with columns that need JSON serialisation.
export const TABLES = {
  roles: {},
  users: {},
  user_roles: {},
  user_attributes: {},
  authority_limits: {},
  segment_config: { json: ['config_value'] },
  policies: { json: ['coverages', 'limits', 'deductibles', 'exclusions'] },
  payees: {},
  claims: { json: ['intake_checklist'] },
  claim_parties: {},
  policy_snapshots: { json: ['snapshot'] },
  policy_renewal_requests: {},
  coverage_results: { json: ['matched_perils', 'applied_limits', 'checks'] },
  claim_assignments: {},
  claim_notes: {},
  claim_status_history: {},
  artifact_requirements: {},
  documents: { json: ['extracted_fields'] },
  document_versions: {},
  tasks: {},
  task_sources: {},
  evaluations: { json: ['checklist', 'evidence'] },
  reserves: {},
  reviews: { json: ['checklist', 'evidence'] },
  fraud_reason_codes: {},
  claim_fraud_flags: {},
  payments: {},
  settlement_approval_steps: {},
  payment_attempts: { json: ['raw_response'] },
  payment_blocks: {},
  notifications: {},
  audit_logs: { json: ['before', 'after', 'metadata'] },
  claim_status_transitions: {},
  ai_runs: { json: ['output'] },
  claim_reminders: {},
  sla_clocks: {},
  closure_requests: {},
  recoveries: {},
  claim_xref: {},
  source_precedence: {},
  integration_sync_runs: {},
  consents: {},
}

export function assertTable(table) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, table)) {
    throw new Error(`Unknown table: ${table}`)
  }
}

export function jsonColumns(table) {
  return TABLES[table]?.json || []
}
