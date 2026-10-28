import { ROLES as R } from './constants.js'

const CLIENT = R.CLIENT
// Claims Operations Manager: intake, coverage, routing and payee details for new claims.
const COM = R.CLAIMS_OPS_MANAGER
// Claims Manager: approvals, denials, closure and reopening.
const MGR = R.OPS_MANAGER
const ADJ = R.ADJUSTER
const DR = R.DOCUMENT_REVIEWER
const PAY = R.PAYMENT_OPERATOR
const DE = R.DATA_ENGINEER
const CS = R.COMPLIANCE_SECURITY

/**
 * Action permissions, following the PRD authorization matrix (section 2.2).
 * The server enforces these on every endpoint; the client uses the same map
 * only to decide what to render. ABAC limits (claim scope, monetary authority,
 * separation of duties) are applied on top by the services and the database.
 */
export const PERMISSIONS = {
  'claims.create': [CLIENT, COM],
  'claims.viewQueue': [COM, MGR, DR, ADJ, CS, PAY, DE],
  'claims.updateMeta': [COM, MGR],
  'claims.verifyCoverage': [COM],
  'claims.intakeChecklist': [COM],
  'claims.escalate': [COM, MGR, ADJ],
  'claims.documentException': [MGR],
  'claims.assign': [COM, MGR],
  'claims.assignAdjuster': [COM, MGR],
  'claims.notes.internal': [COM, MGR, DR, ADJ, CS, PAY],
  'claims.notes.customer': [COM, MGR, DR, ADJ],
  'claims.requestClosure': [ADJ],
  'claims.decideClosure': [MGR],

  'documents.upload': [CLIENT, COM, MGR, DR, ADJ],
  'documents.review': [DR],
  'documents.assignReviewer': [COM, MGR, DR],
  'documents.requestMissing': [COM, MGR, DR, ADJ],

  'tasks.create': [COM, MGR, DR, ADJ, CS, PAY, DE],
  'tasks.update': [COM, MGR, DR, ADJ, CS, PAY, DE],

  'evaluations.write': [ADJ],
  'evaluations.return': [MGR],

  'reserves.set': [ADJ],
  'reserves.review': [MGR],

  'settlements.approve': [ADJ, MGR],

  'compliance.review': [CS],
  'compliance.view': [CS, MGR],

  'fraud.viewScore': [MGR, CS],
  'fraud.viewBand': [MGR, CS, ADJ, COM],

  'payments.view': [PAY, MGR, CS],
  'payments.issue': [PAY],
  'payments.reconcile': [PAY],
  'payments.viewBeneficiary': [PAY],
  'payees.manage': [PAY],
  // Payee and bank details are collected and verified at intake, before the claim moves on.
  'payees.intake': [COM],
  'payees.verify': [COM, PAY],
  'policies.requestRenewal': [CLIENT],
  'policies.decideRenewal': [COM, MGR],

  'recoveries.write': [ADJ, MGR],
  'recoveries.view': [ADJ, MGR, CS, PAY],

  'reports.view': [COM, MGR, CS, PAY, DE],
  'reports.teamMetrics': [MGR, CS],
  'audit.view': [CS, MGR, DE],
  'audit.viewAll': [CS],
  'admin.users': [CS],
  'admin.jobs': [CS, MGR],

  // Segment configuration and authority limits change by four-eyes approval.
  'config.view': [COM, MGR, CS, PAY, DE],
  'config.propose': [CS, MGR],
  'config.approve': [CS, MGR],

  'integrations.view': [DE, CS],
  'integrations.manage': [DE],

  // Centralized customer records are part of Compliance & Security's remit.
  'customers.view': [CS],
  'customers.viewDocuments': [CS],
  'customers.export': [CS],

  // Automation. AI output is advisory: applying extracted values needs a
  // separate, explicit permission.
  'automation.view': [COM, MGR, DR, CS],
  'automation.documentChecklist': [COM, MGR, DR],
  'automation.extract': [COM, MGR, DR],
  'automation.applyExtraction': [COM, MGR, DR],
  'automation.summarize': [COM, MGR],
  'automation.reminders': [COM, MGR, DR],
}

/** Tabs of the unified Claim Details workspace and the roles that may see them. */
export const CLAIM_TABS = [
  { key: 'overview', label: 'Overview', roles: [COM, MGR, DR, ADJ, CS, PAY, DE] },
  { key: 'policy', label: 'Policy & Coverage', roles: [COM, MGR, DR, ADJ, CS] },
  { key: 'documents', label: 'Documents', roles: [COM, MGR, DR, ADJ, CS] },
  { key: 'investigation', label: 'Evaluation', roles: [MGR, ADJ, CS] },
  { key: 'tasks', label: 'Tasks', roles: [COM, MGR, DR, ADJ, CS, PAY] },
  { key: 'reserves', label: 'Reserves', roles: [MGR, ADJ, CS, PAY] },
  { key: 'approvals', label: 'Approvals', roles: [MGR, ADJ, CS, PAY] },
  { key: 'compliance', label: 'Compliance', roles: [CS, MGR] },
  { key: 'payments', label: 'Payments', roles: [PAY, MGR, CS] },
  { key: 'recovery', label: 'Closure & Recovery', roles: [MGR, ADJ, CS] },
  { key: 'automation', label: 'Automation', roles: [COM, MGR, DR, CS] },
  { key: 'activity', label: 'Activity', roles: [COM, MGR, DR, ADJ, CS, PAY, DE] },
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

export { CLIENT as CLIENT_ROLE }
