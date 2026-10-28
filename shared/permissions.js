import { ROLES as R } from './constants.js'

const OPS = R.CLAIMS_OPERATIONS
const MGR = R.CLAIMS_MANAGER
const DR = R.DOCUMENT_REVIEWER
const ADJ = R.CLAIMS_ADJUSTER
const PAY = R.PAYMENT_OPERATIONS
const CO = R.COMPLIANCE_OFFICER
const ADMIN = R.DATA_ADMIN
const AUD = R.AUDITOR
const CRA = R.CUSTOMER_RECORDS_ADMIN
const CUST = R.CUSTOMER

/**
 * Action permissions. The server enforces these on every endpoint; the client
 * uses the same map only to decide what to render. AUDITOR never appears in a
 * mutating permission (read-only role).
 */
export const PERMISSIONS = {
  'claims.create': [CUST, OPS],
  'claims.viewQueue': [OPS, MGR, DR, ADJ, CO, PAY, AUD],
  'claims.updateMeta': [OPS, MGR],
  'claims.verifyPolicy': [OPS, MGR],
  'claims.intakeChecklist': [OPS, MGR],
  'claims.escalate': [OPS, MGR],
  'claims.documentException': [MGR],
  'claims.assign': [OPS, MGR],
  'claims.assignAdjuster': [MGR, OPS],
  'claims.notes.internal': [OPS, MGR, DR, ADJ, CO, PAY],
  'claims.notes.customer': [OPS, MGR, DR, ADJ],

  'documents.upload': [CUST, OPS, DR, ADJ, CO],
  'documents.review': [DR, MGR],
  'documents.assignReviewer': [OPS, MGR, DR],
  'documents.requestMissing': [OPS, DR, ADJ, MGR],

  'tasks.create': [OPS, MGR, DR, ADJ, CO, PAY],
  'tasks.update': [OPS, MGR, DR, ADJ, CO, PAY],

  'assessments.write': [ADJ],
  'assessments.return': [MGR],

  'reserves.decide': [MGR],
  'settlements.decide': [MGR],

  'compliance.review': [CO],
  'compliance.view': [CO, MGR, AUD],

  'payments.view': [PAY, MGR, AUD, CO],
  'payments.process': [PAY],
  'payments.reconcile': [PAY],
  'payments.viewBeneficiary': [PAY],

  'reports.view': [OPS, MGR, CO, PAY, ADMIN, AUD],
  'reports.teamMetrics': [OPS, MGR, ADMIN, AUD],
  'audit.view': [AUD, CO, MGR, ADMIN],
  'admin.users': [ADMIN],
  'admin.jobs': [ADMIN, MGR],

  // Centralized customer records: one designated read-only role. Creating,
  // editing and deleting customers is not offered through this module.
  'customers.view': [CRA],
  'customers.viewDocuments': [CRA],
  'customers.export': [CRA],

  // Automation for claims officers (Claims Operations) and managers. AI output
  // is advisory: applying extracted values needs a separate, explicit permission.
  'automation.view': [OPS, MGR, AUD],
  'automation.documentChecklist': [OPS, MGR],
  'automation.extract': [OPS, MGR],
  'automation.applyExtraction': [OPS, MGR],
  'automation.summarize': [OPS, MGR],
  'automation.reminders': [OPS, MGR],
}

/** Tabs of the unified Claim Details workspace and the roles that may see them. */
export const CLAIM_TABS = [
  { key: 'overview', label: 'Overview', roles: [OPS, MGR, DR, ADJ, CO, PAY, AUD] },
  { key: 'policy', label: 'Policy', roles: [OPS, MGR, DR, ADJ, CO, AUD] },
  { key: 'documents', label: 'Documents', roles: [OPS, MGR, DR, ADJ, CO, AUD] },
  { key: 'investigation', label: 'Investigation', roles: [OPS, MGR, ADJ, CO, AUD] },
  { key: 'tasks', label: 'Tasks', roles: [OPS, MGR, DR, ADJ, CO, PAY, AUD] },
  { key: 'reserves', label: 'Reserves', roles: [MGR, ADJ, CO, AUD] },
  { key: 'approvals', label: 'Approvals', roles: [MGR, ADJ, CO, PAY, AUD] },
  { key: 'compliance', label: 'Compliance', roles: [CO, MGR, AUD] },
  { key: 'payments', label: 'Payments', roles: [PAY, MGR, CO, AUD] },
  { key: 'automation', label: 'Automation', roles: [OPS, MGR, AUD] },
  { key: 'activity', label: 'Activity', roles: [OPS, MGR, DR, ADJ, CO, PAY, AUD] },
]

export function hasAnyRole(roles = [], allowed = []) {
  return roles.some((r) => allowed.includes(r))
}

export function can(roles, permission) {
  const allowed = PERMISSIONS[permission]
  if (!allowed) throw new Error(`Unknown permission: ${permission}`)
  return hasAnyRole(roles, allowed)
}

export function canSeeTab(roles, tabKey) {
  const tab = CLAIM_TABS.find((t) => t.key === tabKey)
  return Boolean(tab && hasAnyRole(roles, tab.roles))
}

export function visibleTabs(roles) {
  return CLAIM_TABS.filter((t) => hasAnyRole(roles, t.roles)).map((t) => t.key)
}

export function permissionsFor(roles) {
  return Object.keys(PERMISSIONS).filter((p) => can(roles, p))
}

export { CUST as CUSTOMER_ROLE }
