export const ROLES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  CLAIMS_OPERATIONS: 'CLAIMS_OPERATIONS',
  DOCUMENT_REVIEWER: 'DOCUMENT_REVIEWER',
  CLAIMS_ADJUSTER: 'CLAIMS_ADJUSTER',
  CLAIMS_MANAGER: 'CLAIMS_MANAGER',
  PAYMENT_OPERATIONS: 'PAYMENT_OPERATIONS',
  COMPLIANCE_OFFICER: 'COMPLIANCE_OFFICER',
  DATA_ADMIN: 'DATA_ADMIN',
  AUDITOR: 'AUDITOR',
})

export const ALL_ROLES = Object.values(ROLES)
export const STAFF_ROLES = ALL_ROLES.filter((r) => r !== ROLES.CUSTOMER)

export const ROLE_LABELS = {
  CUSTOMER: 'Customer',
  CLAIMS_OPERATIONS: 'Claims Operations',
  DOCUMENT_REVIEWER: 'Document Reviewer',
  CLAIMS_ADJUSTER: 'Claims Adjuster',
  CLAIMS_MANAGER: 'Claims Manager',
  PAYMENT_OPERATIONS: 'Payment Operations',
  COMPLIANCE_OFFICER: 'Compliance Officer',
  DATA_ADMIN: 'Data Administrator',
  AUDITOR: 'Auditor',
}

// Order used to choose a default workspace for users holding several roles.
export const ROLE_PRIORITY = [
  ROLES.CLAIMS_MANAGER,
  ROLES.CLAIMS_OPERATIONS,
  ROLES.COMPLIANCE_OFFICER,
  ROLES.CLAIMS_ADJUSTER,
  ROLES.DOCUMENT_REVIEWER,
  ROLES.PAYMENT_OPERATIONS,
  ROLES.DATA_ADMIN,
  ROLES.AUDITOR,
  ROLES.CUSTOMER,
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
  POLICY_VERIFICATION: 'Policy Verification',
  DOCUMENTS_REQUIRED: 'Documents Required',
  DOCUMENT_REVIEW: 'Document Review',
  ADJUSTER_ASSIGNMENT: 'Adjuster Assignment',
  INVESTIGATION: 'Investigation',
  RESERVE_APPROVAL: 'Reserve Approval',
  COMPLIANCE_REVIEW: 'Compliance Review',
  SETTLEMENT_APPROVAL: 'Settlement Approval',
  PAYMENT_PENDING: 'Payment Pending',
  PAYMENT_FAILED: 'Payment Failed',
  PAID: 'Paid',
  CLOSED: 'Closed',
  REJECTED: 'Rejected',
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
export const PAYMENT_STAGE_STATUSES = ['PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID']

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT']

export const POLICY_TYPES = ['MOTOR', 'PROPERTY', 'HEALTH', 'TRAVEL', 'LIABILITY']
export const POLICY_TYPE_LABELS = {
  MOTOR: 'Motor',
  PROPERTY: 'Home & Property',
  HEALTH: 'Health',
  TRAVEL: 'Travel',
  LIABILITY: 'Liability',
}
export const POLICY_STATUSES = ['ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED']

export const INCIDENT_CATEGORIES = {
  MOTOR: ['COLLISION', 'THEFT', 'VANDALISM', 'WINDSCREEN', 'FIRE', 'WEATHER'],
  PROPERTY: ['FIRE', 'WATER_DAMAGE', 'THEFT', 'STORM', 'ACCIDENTAL_DAMAGE', 'SUBSIDENCE'],
  HEALTH: ['HOSPITALISATION', 'OUTPATIENT', 'SURGERY', 'EMERGENCY'],
  TRAVEL: ['TRIP_CANCELLATION', 'LOST_BAGGAGE', 'MEDICAL_ABROAD', 'TRAVEL_DELAY'],
  LIABILITY: ['THIRD_PARTY_INJURY', 'THIRD_PARTY_PROPERTY', 'PROFESSIONAL_ERROR'],
}

export const DOCUMENT_CATEGORIES = [
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
  'OTHER',
]

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
  SUPERSEDED: 'SUPERSEDED',
})

export const ALLOWED_UPLOAD_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
export const ALLOWED_UPLOAD_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp']
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

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
  'GENERAL',
]

export const ASSIGNMENT_ROLES = ['OPERATIONS_OWNER', 'DOCUMENT_REVIEWER', 'ADJUSTER']
export const ASSIGNMENT_ROLE_REQUIRED_USER_ROLE = {
  OPERATIONS_OWNER: ['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER'],
  DOCUMENT_REVIEWER: ['DOCUMENT_REVIEWER'],
  ADJUSTER: ['CLAIMS_ADJUSTER'],
}

export const ASSESSMENT_STATUSES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SUPERSEDED']
export const SETTLEMENT_RECOMMENDATIONS = ['PAY_FULL', 'PAY_PARTIAL', 'DENY']
export const RESERVE_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED']
export const SETTLEMENT_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED']
export const APPROVAL_DECISIONS = ['APPROVED', 'REJECTED', 'RETURNED']
export const APPROVAL_TYPES = ['RESERVE', 'SETTLEMENT']

export const COMPLIANCE_STATUSES = ['PENDING', 'IN_REVIEW', 'CLEARED', 'HOLD', 'EXCEPTION_APPROVED', 'ESCALATED']
export const COMPLIANCE_DECISIONS = ['CLEAR', 'HOLD', 'EXCEPTION', 'ESCALATE']
export const RISK_FLAG_CODES = [
  'SANCTIONS_MATCH',
  'PEP_MATCH',
  'FRAUD_INDICATOR',
  'LATE_NOTIFICATION',
  'HIGH_VALUE',
  'DUPLICATE_SUSPECTED',
  'INCONSISTENT_STATEMENTS',
  'OTHER',
]

export const PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED', 'CANCELLED']
export const PAYMENT_ATTEMPT_STATUSES = ['PROCESSING', 'SUCCEEDED', 'FAILED']

export const INFORMATION_REQUEST_TYPES = ['DOCUMENT', 'INFORMATION']
export const INFORMATION_REQUEST_STATUSES = ['OPEN', 'RESPONDED', 'CLOSED', 'CANCELLED']

export const INTAKE_CHECKLIST = [
  { key: 'POLICY_ACTIVE', label: 'Policy is active on the incident date' },
  { key: 'COVERAGE_CONFIRMED', label: 'Incident category is covered by the policy' },
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
  { key: 'KYC_VERIFIED', label: 'Beneficiary KYC verified' },
  { key: 'FRAUD_SCORE_REVIEWED', label: 'Fraud score reviewed' },
  { key: 'CONFLICT_OF_INTEREST', label: 'No conflict of interest identified' },
]

export const NOTIFICATION_TYPES = [
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
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'CLAIM_STATUS_CHANGED',
  'CLAIM_CLOSED',
]

export const EMAIL_STATUSES = ['NOT_REQUESTED', 'PENDING', 'LOGGED_DEV', 'SENT', 'FAILED']

export function humanize(value) {
  if (!value) return ''
  return String(value)
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}
