// Tables the repository may address, with columns that need JSON serialisation.
export const TABLES = {
  roles: {},
  profiles: {},
  user_roles: {},
  policies: {},
  claims: { json: ['intake_checklist'] },
  claim_assignments: {},
  claim_notes: {},
  claim_status_history: {},
  information_requests: {},
  documents: {},
  tasks: {},
  assessments: { json: ['checklist', 'evidence'] },
  reserves: {},
  settlements: {},
  approvals: {},
  compliance_reviews: { json: ['checklist', 'risk_flags', 'evidence'] },
  payments: {},
  payment_attempts: { json: ['raw_response'] },
  notifications: {},
  audit_logs: { json: ['before_data', 'after_data', 'metadata'] },
  claim_status_transitions: {},
}

export function assertTable(table) {
  if (!Object.prototype.hasOwnProperty.call(TABLES, table)) {
    throw new Error(`Unknown table: ${table}`)
  }
}

export function jsonColumns(table) {
  return TABLES[table]?.json || []
}
