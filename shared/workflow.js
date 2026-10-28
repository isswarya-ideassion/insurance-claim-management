import { CLAIM_STATUS as S, ROLES as R } from './constants.js'

/**
 * Central definition of every permitted claim status transition.
 *
 * - roles:          roles allowed to execute the transition.
 * - guards:         business conditions evaluated by the server's workflow service.
 * - requiresReason: a free-text reason must accompany the transition.
 * - systemOnly:     only internal services (e.g. payment processing) may execute it.
 * - closure:        'COMPLETED' closures require every obligation to be met;
 *                   'PERMITTED_OUTCOME' closures (rejected/withdrawn claims) cancel open work instead.
 */
// Claims Operations Manager: owns new claims through intake and routing.
const COM = R.CLAIMS_OPS_MANAGER
// Claims Manager: approvals, denials, closure and reopening.
const MGR = R.OPS_MANAGER
const DR = R.DOCUMENT_REVIEWER
const ADJ = R.ADJUSTER
const PAY = R.PAYMENT_OPERATOR
const CS = R.COMPLIANCE_SECURITY
const CLIENT = R.CLIENT

const base = [
  { from: S.DRAFT, to: S.SUBMITTED, roles: [CLIENT, COM], guards: ['policyEligible', 'declarationAccepted'], label: 'Submit claim' },
  { from: S.DRAFT, to: S.WITHDRAWN, roles: [CLIENT], label: 'Discard draft' },

  { from: S.SUBMITTED, to: S.POLICY_VERIFICATION, roles: [COM], label: 'Start coverage verification' },

  { from: S.POLICY_VERIFICATION, to: S.DOCUMENTS_REQUIRED, roles: [COM], guards: ['coverageConfirmed', 'payeeVerified'], label: 'Request documents' },
  { from: S.POLICY_VERIFICATION, to: S.DOCUMENT_REVIEW, roles: [COM], guards: ['coverageConfirmed', 'intakeChecklistComplete', 'payeeVerified'], label: 'Send to document review' },
  { from: S.POLICY_VERIFICATION, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny (not covered)' },

  { from: S.DOCUMENTS_REQUIRED, to: S.DOCUMENT_REVIEW, roles: [CLIENT, COM, DR], guards: ['hasDocumentsAwaitingReview'], label: 'Send documents for review' },
  { from: S.DOCUMENTS_REQUIRED, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny (documents not provided)' },

  { from: S.DOCUMENT_REVIEW, to: S.DOCUMENTS_REQUIRED, roles: [DR, COM], requiresReason: true, label: 'Request more documents' },
  { from: S.DOCUMENT_REVIEW, to: S.ADJUSTER_ASSIGNMENT, roles: [DR, COM], guards: ['requiredDocumentsAccepted'], label: 'Documents complete — triage' },

  { from: S.ADJUSTER_ASSIGNMENT, to: S.INVESTIGATION, roles: [COM, MGR], guards: ['adjusterAssigned'], label: 'Start investigation' },

  { from: S.INVESTIGATION, to: S.DOCUMENTS_REQUIRED, roles: [ADJ], requiresReason: true, label: 'Request additional information' },
  // Reserve decision node: outside adjuster authority -> manager reserve review.
  { from: S.INVESTIGATION, to: S.RESERVE_APPROVAL, roles: [ADJ], guards: ['evaluationSubmitted', 'reservePendingReview'], label: 'Escalate reserve for review' },
  // Reserve decision node: within adjuster authority -> reserve posted, evaluation continues.
  { from: S.INVESTIGATION, to: S.COMPLIANCE_REVIEW, roles: [ADJ], guards: ['evaluationSubmitted', 'reservePosted'], label: 'Submit evaluation' },
  { from: S.INVESTIGATION, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny claim' },

  { from: S.RESERVE_APPROVAL, to: S.INVESTIGATION, roles: [MGR], requiresReason: true, label: 'Return for correction' },
  { from: S.RESERVE_APPROVAL, to: S.COMPLIANCE_REVIEW, roles: [MGR], guards: ['reserveApproved'], label: 'Send to compliance review' },
  { from: S.RESERVE_APPROVAL, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny claim' },

  { from: S.COMPLIANCE_REVIEW, to: S.SETTLEMENT_APPROVAL, roles: [CS], guards: ['complianceCleared', 'noActiveComplianceHold'], label: 'Clear for settlement' },
  { from: S.COMPLIANCE_REVIEW, to: S.INVESTIGATION, roles: [CS, MGR], requiresReason: true, label: 'Return to investigation' },
  { from: S.COMPLIANCE_REVIEW, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny claim' },

  { from: S.SETTLEMENT_APPROVAL, to: S.PAYMENT_PENDING, roles: [ADJ, MGR], guards: ['settlementApproved', 'noActiveComplianceHold'], label: 'Release for payment' },
  { from: S.SETTLEMENT_APPROVAL, to: S.INVESTIGATION, roles: [ADJ, MGR], requiresReason: true, label: 'Return for correction' },
  { from: S.SETTLEMENT_APPROVAL, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny claim' },

  { from: S.PAYMENT_PENDING, to: S.PAID, roles: [PAY], systemOnly: true, guards: ['paymentCompleted'], label: 'Payment issued' },
  { from: S.PAYMENT_PENDING, to: S.PAYMENT_FAILED, roles: [PAY], systemOnly: true, label: 'Payment failed' },
  { from: S.PAYMENT_FAILED, to: S.PAYMENT_PENDING, roles: [PAY], guards: ['noActiveComplianceHold'], label: 'Retry payment' },

  // Only the Claims Manager closes and reopens claims; adjusters submit closure requests.
  {
    from: S.PAID,
    to: S.CLOSED,
    roles: [MGR],
    guards: ['paymentCompleted', 'noOpenMandatoryTasks', 'noPendingApprovals', 'noActiveComplianceHold'],
    closure: 'COMPLETED',
    label: 'Close claim',
  },
  { from: S.REJECTED, to: S.CLOSED, roles: [MGR], guards: ['noActiveComplianceHold'], closure: 'PERMITTED_OUTCOME', label: 'Close denied claim' },
  { from: S.WITHDRAWN, to: S.CLOSED, roles: [MGR], closure: 'PERMITTED_OUTCOME', label: 'Close withdrawn claim' },

  { from: S.REJECTED, to: S.REOPENED, roles: [MGR], requiresReason: true, label: 'Reopen claim' },
  { from: S.CLOSED, to: S.REOPENED, roles: [MGR], requiresReason: true, label: 'Reopen claim' },
  { from: S.REOPENED, to: S.POLICY_VERIFICATION, roles: [MGR], label: 'Resume at coverage verification' },
  { from: S.REOPENED, to: S.DOCUMENT_REVIEW, roles: [MGR], label: 'Resume at document review' },
  { from: S.REOPENED, to: S.INVESTIGATION, roles: [MGR], guards: ['adjusterAssigned'], label: 'Resume investigation' },
  { from: S.ON_HOLD, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Deny claim' },
]

export const HOLDABLE_STATUSES = [
  S.SUBMITTED,
  S.POLICY_VERIFICATION,
  S.DOCUMENTS_REQUIRED,
  S.DOCUMENT_REVIEW,
  S.ADJUSTER_ASSIGNMENT,
  S.INVESTIGATION,
  S.RESERVE_APPROVAL,
  S.COMPLIANCE_REVIEW,
  S.SETTLEMENT_APPROVAL,
  S.PAYMENT_PENDING,
  S.PAYMENT_FAILED,
  S.REOPENED,
]

export const CUSTOMER_WITHDRAWABLE_STATUSES = [
  S.SUBMITTED,
  S.POLICY_VERIFICATION,
  S.DOCUMENTS_REQUIRED,
  S.DOCUMENT_REVIEW,
  S.ADJUSTER_ASSIGNMENT,
  S.INVESTIGATION,
  S.ON_HOLD,
]

const holds = HOLDABLE_STATUSES.map((from) => ({
  from,
  to: S.ON_HOLD,
  roles: [COM, MGR, CS],
  requiresReason: true,
  label: 'Place on hold',
}))

const resumes = HOLDABLE_STATUSES.map((to) => ({
  from: S.ON_HOLD,
  to,
  roles: [COM, MGR, CS],
  guards: ['resumesToHeldStatus', 'noActiveComplianceHold'],
  label: 'Resume from hold',
  resume: true,
}))

const withdrawals = CUSTOMER_WITHDRAWABLE_STATUSES.map((from) => ({
  from,
  to: S.WITHDRAWN,
  roles: [CLIENT],
  requiresReason: true,
  label: 'Withdraw claim',
}))

export const TRANSITIONS = Object.freeze([...base, ...holds, ...resumes, ...withdrawals])

export const GUARD_DESCRIPTIONS = {
  policyEligible: 'The policy must belong to the claimant, be active on the loss date and match the claim type.',
  declarationAccepted: 'The claimant must accept the declaration and consent.',
  coverageConfirmed: 'Coverage verification must be recorded as covered.',
  intakeChecklistComplete: 'Every intake checklist item must be completed.',
  payeeVerified: 'The payee and bank details for this claim must be collected and verified.',
  hasDocumentsAwaitingReview: 'At least one uploaded document must be awaiting review.',
  requiredDocumentsAccepted: 'All required documents must be accepted, or a document exception must be recorded by a manager.',
  adjusterAssigned: 'An adjuster must be assigned to the claim.',
  evaluationSubmitted: 'A loss evaluation must be submitted.',
  reservePendingReview: 'A reserve outside the adjuster’s authority must be awaiting manager review.',
  reservePosted: 'A reserve within the adjuster’s authority must be posted.',
  reserveApproved: 'The reserve must be approved by a manager.',
  complianceCleared: 'Compliance review must be cleared or have an approved exception.',
  noActiveComplianceHold: 'There must be no active compliance hold.',
  settlementApproved: 'Every settlement approval step must be approved.',
  paymentCompleted: 'The settlement payment must be completed.',
  noOpenMandatoryTasks: 'All blocking tasks must be completed or cancelled.',
  noPendingApprovals: 'No reserve review or settlement approval may be pending.',
  resumesToHeldStatus: 'A claim can only resume to the status it was in when placed on hold.',
}

/**
 * Default target service level (hours) for a claim to leave each status.
 * segment_config.sla_hours overrides these per segment (PRD section 3.10).
 */
export const STATUS_SLA_HOURS = {
  SUBMITTED: 24,
  POLICY_VERIFICATION: 48,
  DOCUMENTS_REQUIRED: 14 * 24,
  DOCUMENT_REVIEW: 48,
  ADJUSTER_ASSIGNMENT: 24,
  INVESTIGATION: 10 * 24,
  RESERVE_APPROVAL: 24,
  COMPLIANCE_REVIEW: 72,
  SETTLEMENT_APPROVAL: 48,
  PAYMENT_PENDING: 48,
  PAYMENT_FAILED: 24,
  PAID: 5 * 24,
  REOPENED: 48,
}

export function findTransition(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null
}

export function transitionsFrom(from) {
  return TRANSITIONS.filter((t) => t.from === from)
}

export function rolesCanExecute(transition, roles = []) {
  return transition.roles.filter((r) => roles.includes(r))
}

export function allowedTargets(from) {
  return [...new Set(transitionsFrom(from).map((t) => t.to))]
}
