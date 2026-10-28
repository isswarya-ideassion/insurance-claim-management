import { STATUS_LABELS, CUSTOMER_STATUS_LABELS, humanize } from '@shared/constants.js'
import { Badge } from '@/components/ui/badge.js'

const CLAIM_TONES = {
  DRAFT: 'neutral',
  SUBMITTED: 'navy',
  POLICY_VERIFICATION: 'navy',
  DOCUMENTS_REQUIRED: 'amber',
  DOCUMENT_REVIEW: 'violet',
  ADJUSTER_ASSIGNMENT: 'violet',
  INVESTIGATION: 'teal',
  RESERVE_APPROVAL: 'amber',
  COMPLIANCE_REVIEW: 'orange',
  SETTLEMENT_APPROVAL: 'amber',
  PAYMENT_PENDING: 'teal',
  PAYMENT_FAILED: 'red',
  PAID: 'green',
  CLOSED: 'neutral',
  REJECTED: 'red',
  WITHDRAWN: 'neutral',
  ON_HOLD: 'orange',
  REOPENED: 'navy',
}

const GENERIC_TONES = {
  PENDING_REVIEW: 'amber',
  ACCEPTED: 'green',
  REJECTED: 'red',
  SUPERSEDED: 'neutral',
  OPEN: 'navy',
  IN_PROGRESS: 'teal',
  DONE: 'green',
  CANCELLED: 'neutral',
  RESPONDED: 'teal',
  CLOSED: 'neutral',
  PENDING_APPROVAL: 'amber',
  APPROVED: 'green',
  RETURNED: 'orange',
  DRAFT: 'neutral',
  SUBMITTED: 'navy',
  PENDING: 'amber',
  PROCESSING: 'teal',
  PAID: 'green',
  FAILED: 'red',
  RECONCILED: 'green',
  SUCCEEDED: 'green',
  IN_REVIEW: 'navy',
  CLEARED: 'green',
  HOLD: 'red',
  EXCEPTION_APPROVED: 'violet',
  ESCALATED: 'orange',
  LOW: 'neutral',
  MEDIUM: 'navy',
  HIGH: 'amber',
  URGENT: 'red',
  ACTIVE: 'green',
  LAPSED: 'amber',
  EXPIRED: 'neutral',
}

export function ClaimStatusBadge({ status, customer = false, label }) {
  if (!status) return null
  const text = label || (customer ? CUSTOMER_STATUS_LABELS[status] : STATUS_LABELS[status]) || humanize(status)
  return (
    <Badge tone={CLAIM_TONES[status] || 'neutral'} dot>
      {text}
    </Badge>
  )
}

export function StatusBadge({ value, label }) {
  if (!value) return null
  return (
    <Badge tone={GENERIC_TONES[value] || 'neutral'} dot>
      {label || humanize(value)}
    </Badge>
  )
}

export function PriorityBadge({ value }) {
  if (!value) return null
  return <Badge tone={GENERIC_TONES[value] || 'neutral'}>{humanize(value)}</Badge>
}
