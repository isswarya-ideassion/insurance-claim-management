import { REQUIRED_DOCUMENTS } from '../../../shared/constants.js'
import { STATUS_SLA_HOURS } from '../../../shared/workflow.js'

/**
 * Segment-driven configuration (PRD FR-X6). Values come from the active
 * segment_config row; the shared defaults apply when a key has no active row.
 */
const DEFAULTS = {
  required_artifacts: REQUIRED_DOCUMENTS,
  sla_hours: STATUS_SLA_HOURS,
  severity_thresholds: { MEDIUM: 5000, HIGH: 50000, CATASTROPHIC: 200000 },
  fraud_review_threshold: 60,
  unclaimed_task_escalation_hours: 12,
}

export const CONFIG_KEYS = Object.keys(DEFAULTS)

export async function getSegmentConfig(t, segment, key) {
  const row = await t.findOne('segment_config', { segment: segment || 'PERSONAL', config_key: key, status: 'ACTIVE' })
  return row ? row.config_value : DEFAULTS[key]
}

export async function requiredArtifacts(t, segment, claimType) {
  const byType = await getSegmentConfig(t, segment, 'required_artifacts')
  return byType?.[claimType] || []
}

export async function slaHours(t, segment, status) {
  const hours = await getSegmentConfig(t, segment, 'sla_hours')
  return hours?.[status] ?? null
}

export async function severityFor(t, segment, amount) {
  if (amount == null) return null
  const thresholds = await getSegmentConfig(t, segment, 'severity_thresholds')
  const value = Number(amount)
  if (value >= thresholds.CATASTROPHIC) return 'CATASTROPHIC'
  if (value >= thresholds.HIGH) return 'HIGH'
  if (value >= thresholds.MEDIUM) return 'MEDIUM'
  return 'LOW'
}

/**
 * Monetary authority of a user for a segment and coverage line. Computed by the
 * public.effective_limit() database function, which the approval triggers use too.
 */
export async function effectiveLimit(t, userId, limitType, segment, coverageLine = '*') {
  const [row] = await t.query('select public.effective_limit($1, $2, $3, $4) as amount', [userId, limitType, segment || 'PERSONAL', coverageLine])
  return row?.amount == null ? null : Number(row.amount)
}

/** Who approves a settlement: the assigned adjuster within the adjuster settlement limit, else a Claims Manager. */
export async function settlementApproverRole(t, segment, amount) {
  const [row] = await t.query(
    `select max_amount from public.authority_limits
      where role = 'ADJUSTER' and limit_type = 'SETTLEMENT' and segment = $1 and coverage_line = '*'
        and effective_from <= now() and (effective_to is null or effective_to > now())
      order by effective_from desc limit 1`,
    [segment || 'PERSONAL'],
  )
  return row && Number(amount) <= Number(row.max_amount) ? 'ADJUSTER' : 'OPS_MANAGER'
}

/** Limits by segment for the profile screen. */
export async function limitsForUser(t, userId) {
  const out = {}
  for (const type of ['RESERVE', 'SETTLEMENT']) {
    out[type.toLowerCase()] = {}
    for (const segment of ['PERSONAL', 'COMMERCIAL']) {
      out[type.toLowerCase()][segment] = await effectiveLimit(t, userId, type, segment)
    }
  }
  return out
}
