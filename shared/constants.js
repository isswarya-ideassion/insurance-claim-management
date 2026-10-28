// The seven roles defined in the PRD (section 2). Former role codes are mapped
// onto these by migration 20261022000007 (see LEGACY_ROLE_MAP).
export const ROLES = Object.freeze({
  CLIENT: 'CLIENT',
  // Owns new claims: intake, coverage, routing and payee details (migration 20261026000010).
  CLAIMS_OPS_MANAGER: 'CLAIMS_OPS_MANAGER',
  // Claims Manager: approvals, denials, closure and reopening.
  OPS_MANAGER: 'OPS_MANAGER',
  ADJUSTER: 'ADJUSTER',
  DOCUMENT_REVIEWER: 'DOCUMENT_REVIEWER',
  PAYMENT_OPERATOR: 'PAYMENT_OPERATOR',
  DATA_ENGINEER: 'DATA_ENGINEER',
  COMPLIANCE_SECURITY: 'COMPLIANCE_SECURITY',
})

export const ALL_ROLES = Object.values(ROLES)
export const STAFF_ROLES = ALL_ROLES.filter((r) => r !== ROLES.CLIENT)

export const ROLE_LABELS = {
  CLIENT: 'Client / Policyholder',
  CLAIMS_OPS_MANAGER: 'Claims Operations Manager',
  OPS_MANAGER: 'Claims Manager',
  ADJUSTER: 'Adjuster',
  DOCUMENT_REVIEWER: 'Document Review Team',
  PAYMENT_OPERATOR: 'Payment Operator',
  DATA_ENGINEER: 'Data Engineer',
  COMPLIANCE_SECURITY: 'Compliance & Security',
}

/** Role codes before the PRD alignment, and the role each one became. */
export const LEGACY_ROLE_MAP = {
  CUSTOMER: ROLES.CLIENT,
  CLAIMS_OPERATIONS: ROLES.OPS_MANAGER,
  CLAIMS_MANAGER: ROLES.OPS_MANAGER,
  CLAIMS_ADJUSTER: ROLES.ADJUSTER,
  DOCUMENT_REVIEWER: ROLES.DOCUMENT_REVIEWER,
  PAYMENT_OPERATIONS: ROLES.PAYMENT_OPERATOR,
  DATA_ADMIN: ROLES.DATA_ENGINEER,
  COMPLIANCE_OFFICER: ROLES.COMPLIANCE_SECURITY,
  AUDITOR: ROLES.COMPLIANCE_SECURITY,
  CUSTOMER_RECORDS_ADMIN: ROLES.COMPLIANCE_SECURITY,
}

// Order used to choose a default workspace for users holding several roles.
export const ROLE_PRIORITY = [
  ROLES.OPS_MANAGER,
  ROLES.CLAIMS_OPS_MANAGER,
  ROLES.COMPLIANCE_SECURITY,
  ROLES.ADJUSTER,
  ROLES.DOCUMENT_REVIEWER,
  ROLES.PAYMENT_OPERATOR,
  ROLES.DATA_ENGINEER,
  ROLES.CLIENT,
]

export const CLAIM_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  POLICY_VERIFICATION: 'POLICY_VERIFICATION',
  DOCUMENTS_REQUIRED: 'DOCUMENTS_REQUIRED',
  DOCUMENT_REVIEW: 'DOCUMENT_REVIEW',
  ADJUSTER_ASSIGNMENT: 'ADJUSTER_ASSIGNMENT',
  INVESTIGATION: 'INVESTIGATION',
  RESERVE_APPROVAL: 'RESERVE_APPROVAL',
  COMPLIANCE_REVIEW: 'COMPLIANCE_REVIEW',
  SETTLEMENT_APPROVAL: 'SETTLEMENT_APPROVAL',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAID: 'PAID',
  CLOSED: 'CLOSED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  ON_HOLD: 'ON_HOLD',
  REOPENED: 'REOPENED',
})

export const ALL_STATUSES = Object.values(CLAIM_STATUS)

export const STATUS_LABELS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  POLICY_VERIFICATION: 'Coverage Verification',
  DOCUMENTS_REQUIRED: 'Documents Required',
  DOCUMENT_REVIEW: 'Document Review',
  ADJUSTER_ASSIGNMENT: 'Triage & Assignment',
  INVESTIGATION: 'Investigation',
  RESERVE_APPROVAL: 'Reserve Review',
  COMPLIANCE_REVIEW: 'Compliance Review',
  SETTLEMENT_APPROVAL: 'Settlement Approval',
  PAYMENT_PENDING: 'Payment Pending',
  PAYMENT_FAILED: 'Payment Failed',
  PAID: 'Paid',
  CLOSED: 'Closed',
  REJECTED: 'Denied',
  WITHDRAWN: 'Withdrawn',
  ON_HOLD: 'On Hold',
  REOPENED: 'Reopened',
}

// Customer-facing wording. Internal stages (including holds) are never revealed verbatim.
export const CUSTOMER_STATUS_LABELS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  POLICY_VERIFICATION: 'Under review',
  DOCUMENTS_REQUIRED: 'Action required: documents',
  DOCUMENT_REVIEW: 'Under review',
  ADJUSTER_ASSIGNMENT: 'Under review',
  INVESTIGATION: 'Being assessed',
  RESERVE_APPROVAL: 'Being assessed',
  COMPLIANCE_REVIEW: 'Being assessed',
  SETTLEMENT_APPROVAL: 'Settlement in approval',
  PAYMENT_PENDING: 'Payment processing',
  PAYMENT_FAILED: 'Payment delayed',
  PAID: 'Paid',
  CLOSED: 'Closed',
  REJECTED: 'Not approved',
  WITHDRAWN: 'Withdrawn',
  ON_HOLD: 'Under review',
  REOPENED: 'Reopened',
}

// The nine lifecycle stages of the PRD. claims.stage is derived from the status
// by a database trigger (public.claim_stage) using the same mapping.
export const LIFECYCLE_STAGES = [
  'FNOL',
  'COVERAGE_VERIFICATION',
  'TRIAGE',
  'INVESTIGATION',
  'RESERVE',
  'EVALUATION',
  'SETTLEMENT',
  'PAYMENT',
  'CLOSURE',
]
export const STAGE_LABELS = {
  FNOL: 'First Notice of Loss',
  COVERAGE_VERIFICATION: 'Coverage Verification',
  TRIAGE: 'Triage & Assignment',
  INVESTIGATION: 'Investigation & Document Intake',
  RESERVE: 'Reserve Management',
  EVALUATION: 'Evaluation & Decision',
  SETTLEMENT: 'Settlement & Authorization',
  PAYMENT: 'Payment Issuance',
  CLOSURE: 'Closure & Recovery',
}
export const STATUS_STAGE = {
  DRAFT: 'FNOL',
  SUBMITTED: 'FNOL',
  POLICY_VERIFICATION: 'COVERAGE_VERIFICATION',
  DOCUMENTS_REQUIRED: 'INVESTIGATION',
  DOCUMENT_REVIEW: 'INVESTIGATION',
  ADJUSTER_ASSIGNMENT: 'TRIAGE',
  INVESTIGATION: 'INVESTIGATION',
  RESERVE_APPROVAL: 'RESERVE',
  COMPLIANCE_REVIEW: 'EVALUATION',
  SETTLEMENT_APPROVAL: 'SETTLEMENT',
  PAYMENT_PENDING: 'PAYMENT',
  PAYMENT_FAILED: 'PAYMENT',
  PAID: 'PAYMENT',
  CLOSED: 'CLOSURE',
  REJECTED: 'EVALUATION',
  WITHDRAWN: 'CLOSURE',
  REOPENED: 'CLOSURE',
}

export const TERMINAL_STATUSES = [CLAIM_STATUS.CLOSED]
export const ACTIVE_STATUSES = [
  'SUBMITTED',
  'POLICY_VERIFICATION',
  'DOCUMENTS_REQUIRED',
  'DOCUMENT_REVIEW',
  'ADJUSTER_ASSIGNMENT',
  'INVESTIGATION',
  'RESERVE_APPROVAL',
  'COMPLIANCE_REVIEW',
  'SETTLEMENT_APPROVAL',
  'PAYMENT_PENDING',
  'PAYMENT_FAILED',
  'REOPENED',
]

export const DOCUMENT_STAGE_STATUSES = ['POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW']
export const COMPLIANCE_STAGE_STATUSES = ['COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'ON_HOLD']
export const PAYMENT_STAGE_STATUSES = ['SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID']

// Statuses whose SLA clock is paused because the insurer is waiting on someone else.
export const SLA_PAUSED_STATUSES = ['DOCUMENTS_REQUIRED', 'ON_HOLD']

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT']

export const SEGMENTS = ['PERSONAL', 'COMMERCIAL']
export const SEGMENT_LABELS = { PERSONAL: 'Personal', COMMERCIAL: 'Commercial' }
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CATASTROPHIC']
export const COMPLEXITY_TIERS = [1, 2, 3, 4]
export const COVERAGE_RESULTS = ['COVERED', 'NOT_COVERED', 'NEEDS_REVIEW']

export const POLICY_TYPES = ['MOTOR', 'PROPERTY', 'HEALTH', 'TRAVEL', 'LIABILITY']
export const POLICY_TYPE_LABELS = {
  MOTOR: 'Motor',
  PROPERTY: 'Home & Property',
  HEALTH: 'Health',
  TRAVEL: 'Travel',
  LIABILITY: 'Liability',
}
export const POLICY_STATUSES = ['ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED']

/** Loss types (incident categories) a policy type can cover. */
export const LOSS_TYPES = {
  MOTOR: ['COLLISION', 'THEFT', 'VANDALISM', 'WINDSCREEN', 'FIRE', 'WEATHER'],
  PROPERTY: ['FIRE', 'WATER_DAMAGE', 'THEFT', 'STORM', 'ACCIDENTAL_DAMAGE', 'SUBSIDENCE'],
  HEALTH: ['HOSPITALISATION', 'OUTPATIENT', 'SURGERY', 'EMERGENCY'],
  TRAVEL: ['TRIP_CANCELLATION', 'LOST_BAGGAGE', 'MEDICAL_ABROAD', 'TRAVEL_DELAY'],
  LIABILITY: ['THIRD_PARTY_INJURY', 'THIRD_PARTY_PROPERTY', 'PROFESSIONAL_ERROR'],
}

/** Reserve coverage lines per policy type; the first is the default line. */
export const COVERAGE_LINES = {
  MOTOR: ['OWN_DAMAGE', 'THIRD_PARTY_LIABILITY'],
  PROPERTY: ['BUILDING', 'CONTENTS'],
  HEALTH: ['MEDICAL'],
  TRAVEL: ['TRAVEL'],
  LIABILITY: ['LIABILITY'],
}
export const defaultCoverageLine = (claimType) => COVERAGE_LINES[claimType]?.[0] || 'PRIMARY'

export const DOCUMENT_TYPES = [
  'CLAIM_FORM',
  'PROOF_OF_LOSS',
  'PHOTOS',
  'POLICE_REPORT',
  'REPAIR_ESTIMATE',
  'MEDICAL_REPORT',
  'INVOICE',
  'ID_PROOF',
  'INVESTIGATION_EVIDENCE',
  'COMPLIANCE_EVIDENCE',
  'DENIAL_LETTER',
  'OTHER',
]
// Internal document types are never shown to clients.
export const INTERNAL_DOCUMENT_TYPES = ['INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE']

/** Default required artifacts per claim type; segment_config.required_artifacts overrides these. */
export const REQUIRED_DOCUMENTS = {
  MOTOR: ['PROOF_OF_LOSS', 'PHOTOS', 'REPAIR_ESTIMATE'],
  PROPERTY: ['PROOF_OF_LOSS', 'PHOTOS'],
  HEALTH: ['MEDICAL_REPORT', 'INVOICE'],
  TRAVEL: ['PROOF_OF_LOSS', 'INVOICE'],
  LIABILITY: ['PROOF_OF_LOSS'],
}

export const DOCUMENT_STATUS = Object.freeze({
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
})
export const DOCUMENT_SOURCES = ['WEB', 'PWA', 'EMAIL', 'DMS', 'STAFF']

export const ALLOWED_UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
export const ALLOWED_UPLOAD_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp']
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

// Artifact requirements: required documents per claim plus ad-hoc document and
// information requests to the client.
export const REQUIREMENT_TYPES = ['DOCUMENT', 'INFORMATION']
export const ARTIFACT_STATUSES = ['MISSING', 'REQUESTED', 'RECEIVED', 'ACCEPTED', 'REJECTED', 'WAIVED', 'CLOSED', 'CANCELLED']
/** Statuses in which the client still owes something. */
export const OPEN_REQUEST_STATUSES = ['REQUESTED']
export const ARTIFACT_STATUS_LABELS = {
  MISSING: 'Missing',
  REQUESTED: 'Requested',
  RECEIVED: 'Received',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WAIVED: 'Waived',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
}

export const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']
export const OPEN_TASK_STATUSES = ['OPEN', 'IN_PROGRESS']
export const TASK_TYPES = [
  'INTAKE_REVIEW',
  'POLICY_CHECK',
  'DOCUMENT_FOLLOW_UP',
  'DOCUMENT_REVIEW',
  'ASSIGN_ADJUSTER',
  'INVESTIGATION',
  'APPROVAL',
  'COMPLIANCE',
  'PAYMENT',
  'PAYMENT_BLOCK',
  'CLOSURE',
  'POLICY_RENEWAL',
  'GENERAL',
]

export const ASSIGNMENT_ROLES = ['OPERATIONS_OWNER', 'DOCUMENT_REVIEWER', 'ADJUSTER']
export const ASSIGNMENT_ROLE_REQUIRED_USER_ROLE = {
  OPERATIONS_OWNER: [ROLES.CLAIMS_OPS_MANAGER],
  DOCUMENT_REVIEWER: [ROLES.DOCUMENT_REVIEWER],
  ADJUSTER: [ROLES.ADJUSTER],
}

export const EVALUATION_STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SUPERSEDED']
export const EVALUATION_DECISIONS = ['PAY_FULL', 'PAY_PARTIAL', 'DENY']

// Reserves are ledger rows: amounts never change, a new row records each change.
export const RESERVE_STATUSES = ['POSTED', 'PENDING_REVIEW', 'APPROVED', 'MODIFIED', 'REJECTED', 'RETURNED', 'SUPERSEDED']
export const ACTIVE_RESERVE_STATUSES = ['POSTED', 'APPROVED']
export const RESERVE_REVIEW_DECISIONS = ['APPROVED', 'MODIFIED', 'REJECTED', 'RETURNED']
export const RESERVE_REASON_CODES = [
  'INITIAL',
  'REVISED_ESTIMATE',
  'NEW_INFORMATION',
  'MANAGER_MODIFIED',
  'PAYMENT_ISSUED',
  'CLOSURE_RELEASE',
  'AI_RECOMMENDATION_ACCEPTED',
  'OTHER',
]

// Settlements and payments share one lifecycle in the payments table.
export const PAYMENT_STATUSES = [
  'PENDING_APPROVAL',
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'RECONCILED',
  'REJECTED',
  'RETURNED',
  'CANCELLED',
]
export const PAYMENT_METHODS = ['EFT', 'CHECK']
export const PAYMENT_ATTEMPT_STATUSES = ['PROCESSING', 'SUCCEEDED', 'FAILED']
export const APPROVAL_STEP_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED']
export const SETTLEMENT_DECISIONS = ['APPROVED', 'REJECTED', 'RETURNED']
export const PAYEE_VERIFICATION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'FAILED']
export const PAYMENT_BLOCK_TYPES = ['PAYMENT_FAILED', 'COMPLIANCE_HOLD', 'PAYEE_UNVERIFIED', 'BANK_DETAILS_CHANGED']

// Reverse-review checkpoints (reviews table).
export const REVIEW_CHECKPOINTS = ['COMPLIANCE', 'RESERVE', 'EVALUATION', 'CLOSURE']
export const COMPLIANCE_STATUSES = ['PENDING', 'IN_REVIEW', 'CLEARED', 'HOLD', 'EXCEPTION_APPROVED', 'ESCALATED']
export const OPEN_COMPLIANCE_STATUSES = ['PENDING', 'IN_REVIEW', 'HOLD', 'ESCALATED']
export const COMPLIANCE_DECISIONS = ['CLEAR', 'HOLD', 'EXCEPTION', 'ESCALATE']

/** Approved fraud reason-code taxonomy (seeded into fraud_reason_codes). */
export const FRAUD_REASON_CODES = [
  'SANCTIONS_MATCH',
  'PEP_MATCH',
  'FRAUD_INDICATOR',
  'LATE_NOTIFICATION',
  'HIGH_VALUE',
  'DUPLICATE_SUSPECTED',
  'INCONSISTENT_STATEMENTS',
  'OTHER',
]
export const FRAUD_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH']
/** Risk band shown to roles that may not see the numeric fraud score. */
export function fraudBand(score) {
  if (score == null) return null
  if (score >= 60) return 'HIGH'
  if (score >= 30) return 'MEDIUM'
  return 'LOW'
}

export const RECOVERY_TYPES = ['SUBROGATION', 'SALVAGE']
export const RECOVERY_STATUSES = ['IDENTIFIED', 'REFERRED', 'IN_PROGRESS', 'RECOVERED', 'CLOSED', 'ABANDONED']
export const CLOSURE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']

export const SLA_CLOCK_TYPES = ['ACKNOWLEDGE', 'STAGE']

export const INTAKE_CHECKLIST = [
  { key: 'POLICY_ACTIVE', label: 'Policy is active on the loss date' },
  { key: 'COVERAGE_CONFIRMED', label: 'Loss type is covered by the policy' },
  { key: 'CLAIMANT_IDENTITY', label: 'Claimant identity matches the policyholder' },
  { key: 'DUPLICATE_CHECK', label: 'Checked for duplicate claims' },
  { key: 'CONTACT_VERIFIED', label: 'Contact details verified' },
]

export const INVESTIGATION_CHECKLIST = [
  { key: 'SITE_INSPECTION', label: 'Site or asset inspection completed' },
  { key: 'STATEMENTS_COLLECTED', label: 'Claimant and witness statements collected' },
  { key: 'EVIDENCE_REVIEWED', label: 'Documentary evidence reviewed' },
  { key: 'COVERAGE_ANALYSIS', label: 'Coverage and exclusions analysed' },
  { key: 'FRAUD_INDICATORS', label: 'Fraud indicators checked' },
]

export const COMPLIANCE_CHECKLIST = [
  { key: 'SANCTIONS_SCREENING', label: 'Sanctions screening completed' },
  { key: 'AML_CHECK', label: 'Anti-money-laundering check completed' },
  { key: 'KYC_VERIFIED', label: 'Payee KYC verified' },
  { key: 'FRAUD_SCORE_REVIEWED', label: 'Fraud score reviewed' },
  { key: 'CONFLICT_OF_INTEREST', label: 'No conflict of interest identified' },
]

export const NOTIFICATION_TEMPLATES = [
  'CLAIM_SUBMITTED',
  'CLAIM_ASSIGNED',
  'DOCUMENTS_REQUIRED',
  'DOCUMENT_ACCEPTED',
  'DOCUMENT_REJECTED',
  'INFORMATION_REQUESTED',
  'INVESTIGATION_UPDATE',
  'APPROVAL_REQUIRED',
  'APPROVAL_DECISION',
  'COMPLIANCE_HOLD',
  'TASK_ASSIGNED',
  'TASK_OVERDUE',
  'SLA_BREACHED',
  'DEADLINE_REMINDER',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'CLAIM_STATUS_CHANGED',
  'CLAIM_REJECTED',
  'APPROVAL_REJECTED',
  'CLAIM_CLOSED',
  'POLICY_RENEWAL',
]

/** Notifications about something being rejected or denied; the UI marks them with colour, icon and label. */
export const REJECTION_NOTIFICATION_TEMPLATES = ['CLAIM_REJECTED', 'DOCUMENT_REJECTED', 'APPROVAL_REJECTED']
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH']
export const NOTIFICATION_STATUSES = ['PENDING', 'DELIVERED', 'READ', 'LOGGED_DEV', 'SENT', 'FAILED', 'NOT_REQUESTED']

export const CONSENT_TYPES = [
  'PRIVACY_NOTICE',
  'CLAIM_DECLARATION',
  'CHANNEL_EMAIL',
  'CHANNEL_SMS',
  'CHANNEL_PUSH',
  'LOCATION',
  'AUDIO_RECORDING',
]
export const PRIVACY_NOTICE_VERSION = '2026-10'

export const INTEGRATION_SOURCES = ['POLICY_ADMIN', 'DOCUMENT_MANAGEMENT', 'ADJUSTER_ASSIGNMENT', 'PAYMENT_PORTAL', 'LEGACY_CLAIMS']
export const PRECEDENCE_RULES = ['SOURCE_WINS', 'HUB_WINS', 'LATEST_WINS', 'MANUAL_REVIEW']

export function humanize(value) {
  if (!value) return ''
  return String(value)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// ---------------------------------------------------------------------------
// Automation (AI-assisted extraction and summaries, rule-based reminders)
// ---------------------------------------------------------------------------

export const AI_AGENTS = Object.freeze({
  INTAKE_PARSER: 'intake-parser',
  CLAIM_SUMMARIZER: 'claim-summarizer',
})
export const AI_HUMAN_DECISIONS = ['PENDING', 'ACCEPTED', 'REJECTED', 'NOT_REQUIRED']
/** Confidence bands for the 0–1 confidence values agents return (PRD FR-X4). */
export function confidenceBand(value) {
  if (value == null) return null
  if (value >= 0.8) return 'high'
  if (value >= 0.5) return 'medium'
  return 'low'
}

/** Claim fields an extraction may propose; every value needs human confirmation before it is saved. */
export const EXTRACTABLE_CLAIM_FIELDS = [
  { key: 'loss_date', label: 'Loss date', claimField: 'loss_date' },
  { key: 'loss_location', label: 'Loss location', claimField: 'loss_location' },
  { key: 'loss_description', label: 'Loss description', claimField: 'loss_description' },
  { key: 'estimated_loss', label: 'Loss amount', claimField: 'estimated_loss' },
  { key: 'affected_asset', label: 'Affected property or asset', claimField: 'affected_asset' },
  // Reference-only fields: compared with the policy for consistency, never written to the claim.
  { key: 'policy_number', label: 'Policy number', claimField: null },
  { key: 'insured_name', label: 'Insured name', claimField: null },
]

/** Claim statuses in which confirmed extraction values may still update the official claim record. */
export const EXTRACTION_EDITABLE_STATUSES = [
  'SUBMITTED',
  'POLICY_VERIFICATION',
  'DOCUMENTS_REQUIRED',
  'DOCUMENT_REVIEW',
  'ADJUSTER_ASSIGNMENT',
  'INVESTIGATION',
]

export const REMINDER_TYPE_LABELS = {
  DEADLINE_APPROACHING: 'Deadline approaching',
  DEADLINE_OVERDUE: 'Deadline passed',
  MISSING_DOCUMENTS: 'Missing documents',
}

export const REMINDER_STATUS_LABELS = {
  SENT: 'Sent',
  DRAFT: 'Awaiting approval',
  APPROVED: 'Approved and sent',
  DISCARDED: 'Discarded',
}

// ---------------------------------------------------------------------------
// Money and phone numbers (India)
// ---------------------------------------------------------------------------
export const CURRENCY = 'INR'
export const CURRENCY_SYMBOL = '₹'

export const POLICY_RENEWAL_STATUSES = ['REQUESTED', 'COMPLETED', 'DECLINED', 'CANCELLED']

export const INDIAN_MOBILE_MESSAGE = 'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9'

/** The 10-digit subscriber number of an Indian mobile number (with or without +91 / 0), or null. */
export function indianMobileDigits(value) {
  let digits = String(value ?? '').replace(/[\s()-]/g, '')
  if (digits.startsWith('+91')) digits = digits.slice(3)
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return /^[6-9]\d{9}$/.test(digits) ? digits : null
}

/** Canonical form stored and shown everywhere: "+91 98765 43210". */
export function normalizeIndianMobile(value) {
  const d = indianMobileDigits(value)
  return d ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : null
}
