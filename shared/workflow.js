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
const OPS = R.CLAIMS_OPERATIONS
const MGR = R.CLAIMS_MANAGER
const DR = R.DOCUMENT_REVIEWER
const ADJ = R.CLAIMS_ADJUSTER
const PAY = R.PAYMENT_OPERATIONS
const CO = R.COMPLIANCE_OFFICER
const CUST = R.CUSTOMER

const base = [
  { from: S.DRAFT, to: S.SUBMITTED, roles: [CUST, OPS], guards: ['policyEligible', 'declarationAccepted'], label: 'Submit claim' },
  { from: S.DRAFT, to: S.WITHDRAWN, roles: [CUST], label: 'Discard draft' },

  { from: S.SUBMITTED, to: S.POLICY_VERIFICATION, roles: [OPS, MGR], label: 'Start policy verification' },

  { from: S.POLICY_VERIFICATION, to: S.DOCUMENTS_REQUIRED, roles: [OPS, MGR], guards: ['policyVerified'], label: 'Request documents' },
  { from: S.POLICY_VERIFICATION, to: S.DOCUMENT_REVIEW, roles: [OPS, MGR], guards: ['policyVerified', 'intakeChecklistComplete'], label: 'Send to document review' },
  { from: S.POLICY_VERIFICATION, to: S.REJECTED, roles: [OPS, MGR], requiresReason: true, label: 'Reject (policy not eligible)' },

  { from: S.DOCUMENTS_REQUIRED, to: S.DOCUMENT_REVIEW, roles: [CUST, OPS, DR], guards: ['hasDocumentsAwaitingReview'], label: 'Send documents for review' },
  { from: S.DOCUMENTS_REQUIRED, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject (documents not provided)' },

  { from: S.DOCUMENT_REVIEW, to: S.DOCUMENTS_REQUIRED, roles: [DR, OPS, MGR], requiresReason: true, label: 'Request more documents' },
  { from: S.DOCUMENT_REVIEW, to: S.ADJUSTER_ASSIGNMENT, roles: [DR, OPS, MGR], guards: ['requiredDocumentsAccepted'], label: 'Documents complete — assign adjuster' },

  { from: S.ADJUSTER_ASSIGNMENT, to: S.INVESTIGATION, roles: [MGR, OPS], guards: ['adjusterAssigned'], label: 'Start investigation' },

  { from: S.INVESTIGATION, to: S.DOCUMENTS_REQUIRED, roles: [ADJ], requiresReason: true, label: 'Request additional information' },
  { from: S.INVESTIGATION, to: S.RESERVE_APPROVAL, roles: [ADJ], guards: ['assessmentSubmitted', 'reservePending'], label: 'Submit for reserve approval' },
  { from: S.INVESTIGATION, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject claim' },

  { from: S.RESERVE_APPROVAL, to: S.INVESTIGATION, roles: [MGR], requiresReason: true, label: 'Return for correction' },
  { from: S.RESERVE_APPROVAL, to: S.COMPLIANCE_REVIEW, roles: [MGR], guards: ['reserveApproved'], label: 'Send to compliance review' },
  { from: S.RESERVE_APPROVAL, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject claim' },

  { from: S.COMPLIANCE_REVIEW, to: S.SETTLEMENT_APPROVAL, roles: [CO], guards: ['complianceCleared', 'noActiveComplianceHold'], label: 'Clear for settlement' },
  { from: S.COMPLIANCE_REVIEW, to: S.INVESTIGATION, roles: [CO, MGR], requiresReason: true, label: 'Return to investigation' },
  { from: S.COMPLIANCE_REVIEW, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject claim' },

  { from: S.SETTLEMENT_APPROVAL, to: S.PAYMENT_PENDING, roles: [MGR], guards: ['settlementApproved', 'noActiveComplianceHold'], label: 'Release for payment' },
  { from: S.SETTLEMENT_APPROVAL, to: S.INVESTIGATION, roles: [MGR], requiresReason: true, label: 'Return for correction' },
  { from: S.SETTLEMENT_APPROVAL, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject claim' },

  { from: S.PAYMENT_PENDING, to: S.PAID, roles: [PAY], systemOnly: true, guards: ['paymentCompleted'], label: 'Payment succeeded' },
  { from: S.PAYMENT_PENDING, to: S.PAYMENT_FAILED, roles: [PAY], systemOnly: true, label: 'Payment failed' },
  { from: S.PAYMENT_FAILED, to: S.PAYMENT_PENDING, roles: [PAY], guards: ['noActiveComplianceHold'], label: 'Retry payment' },

  {
    from: S.PAID,
    to: S.CLOSED,
    roles: [OPS, MGR],
    guards: ['paymentCompleted', 'noOpenMandatoryTasks', 'noPendingApprovals', 'noActiveComplianceHold'],
    closure: 'COMPLETED',
    label: 'Close claim',
  },
  { from: S.REJECTED, to: S.CLOSED, roles: [OPS, MGR], guards: ['noActiveComplianceHold'], closure: 'PERMITTED_OUTCOME', label: 'Close rejected claim' },
  { from: S.WITHDRAWN, to: S.CLOSED, roles: [OPS, MGR], closure: 'PERMITTED_OUTCOME', label: 'Close withdrawn claim' },

  { from: S.REJECTED, to: S.REOPENED, roles: [MGR], requiresReason: true, label: 'Reopen claim' },
  { from: S.CLOSED, to: S.REOPENED, roles: [MGR], requiresReason: true, label: 'Reopen claim' },
  { from: S.REOPENED, to: S.POLICY_VERIFICATION, roles: [MGR, OPS], label: 'Resume at policy verification' },
  { from: S.REOPENED, to: S.DOCUMENT_REVIEW, roles: [MGR, OPS], label: 'Resume at document review' },
  { from: S.REOPENED, to: S.INVESTIGATION, roles: [MGR], guards: ['adjusterAssigned'], label: 'Resume investigation' },
  { from: S.ON_HOLD, to: S.REJECTED, roles: [MGR], requiresReason: true, label: 'Reject claim' },
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
  roles: [OPS, MGR, CO],
  requiresReason: true,
  label: 'Place on hold',
}))

const resumes = HOLDABLE_STATUSES.map((to) => ({
  from: S.ON_HOLD,
  to,
  roles: [OPS, MGR, CO],
  guards: ['resumesToHeldStatus', 'noActiveComplianceHold'],
  label: 'Resume from hold',
  resume: true,
}))

const withdrawals = CUSTOMER_WITHDRAWABLE_STATUSES.map((from) => ({
  from,
  to: S.WITHDRAWN,
  roles: [CUST],
  requiresReason: true,
  label: 'Withdraw claim',
}))

export const TRANSITIONS = Object.freeze([...base, ...holds, ...resumes, ...withdrawals])

export const GUARD_DESCRIPTIONS = {
  policyEligible: 'The policy must belong to the claimant, be active on the incident date and match the claim type.',
  declarationAccepted: 'The claimant must accept the declaration and consent.',
  policyVerified: 'Policy verification must be recorded as passed.',
  intakeChecklistComplete: 'Every intake checklist item must be completed.',
  hasDocumentsAwaitingReview: 'At least one uploaded document must be awaiting review.',
  requiredDocumentsAccepted: 'All required documents must be accepted, or a document exception must be recorded by a manager.',
  adjusterAssigned: 'An adjuster must be assigned to the claim.',
  assessmentSubmitted: 'A loss assessment must be submitted.',
  reservePending: 'A reserve request must be awaiting approval.',
  reserveApproved: 'The reserve must be approved.',
  complianceCleared: 'Compliance review must be cleared or have an approved exception.',
  noActiveComplianceHold: 'There must be no active compliance hold.',
  settlementApproved: 'The settlement must be approved.',
  paymentCompleted: 'The settlement payment must be completed.',
  noOpenMandatoryTasks: 'All mandatory tasks must be completed or cancelled.',
  noPendingApprovals: 'No reserve or settlement approval may be pending.',
  resumesToHeldStatus: 'A claim can only resume to the status it was in when placed on hold.',
}

// Target service level (hours) for a claim to leave each status.
export const STATUS_SLA_HOURS = {
  SUBMITTED: 24,
  POLICY_VERIFICATION: 48,
  DOCUMENTS_REQUIRED: 14 * 24,
  DOCUMENT_REVIEW: 48,
  ADJUSTER_ASSIGNMENT: 24,
  INVESTIGATION: 10 * 24,
  RESERVE_APPROVAL: 48,
  COMPLIANCE_REVIEW: 72,
  SETTLEMENT_APPROVAL: 48,
  PAYMENT_PENDING: 48,
  PAYMENT_FAILED: 24,
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
