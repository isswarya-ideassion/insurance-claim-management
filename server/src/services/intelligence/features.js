/**
 * Turns a claim row into the numeric vector the models consume.
 *
 * Built for the Indian general-insurance book this system runs (MOTOR,
 * HEALTH, PROPERTY, TRAVEL, LIABILITY; amounts in INR). Feature choice is what
 * decides whether any of this works, so the rules are deliberate:
 *
 * - Nothing that encodes a protected attribute or a proxy for one. No name, no
 *   gender, no age, no location finer than city. The triage agent already
 *   refuses these (TRIAGE_SYSTEM in agents.service.js) and a learned model must
 *   not reintroduce them through the back door. Religion- and caste-adjacent
 *   proxies are the live risk in an Indian book; the surest guard is to never
 *   admit the columns.
 * - Ratios and log amounts rather than raw rupees, so a motor claim and a
 *   health claim stay comparable.
 * - Robust statistics (median, MAD) rather than mean and standard deviation.
 *   A fraud ring inflates the mean of the very population it hides in; the
 *   median barely moves.
 * - claim_type is deliberately NOT one-hot encoded. An Isolation Forest splits
 *   on random axes, so padding the space with sparse indicator columns dilutes
 *   the informative ones. Claim type enters through amount_robust_z, which
 *   compares a claim only against its own line of business.
 */

const DAY = 86_400_000
const days = (a, b) => (a && b ? (new Date(b) - new Date(a)) / DAY : null)
const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v))

const SEVERITY_ORDINAL = { LOW: 1, MEDIUM: 2, HIGH: 3, CATASTROPHIC: 4 }

/**
 * Intimation norms in Indian policy wordings. Motor own-damage and cashless
 * health are expected within a day or two; property and travel allow longer.
 * Delay past these is not fraud, but it is the point where a file stops
 * looking routine and the model should notice.
 */
const INTIMATION_NORM_DAYS = { MOTOR: 2, HEALTH: 1, PROPERTY: 7, TRAVEL: 7, LIABILITY: 7 }

/** Initial waiting period in a standard Indian indemnity health policy. */
const HEALTH_INITIAL_WAITING_DAYS = 30
/** IRDAI-mandated free-look window. */
const FREE_LOOK_DAYS = 15

function median(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
function mad(values, centre) {
  const deviations = values.filter((v) => v != null && Number.isFinite(v)).map((v) => Math.abs(v - centre))
  return 1.4826 * median(deviations) || 1
}

/**
 * Trailing zeros in the rupee amount. Genuine settlements land on awkward
 * figures because they are built from invoices, survey findings and
 * depreciation; fabricated ones cluster on ₹50,000 and ₹1,00,000. Counting
 * zeros keeps this continuous instead of an arbitrary cut-off.
 */
function roundness(amount) {
  const n = Math.round(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  let zeros = 0
  let v = n
  while (v % 10 === 0 && zeros < 7) {
    zeros += 1
    v /= 10
  }
  return zeros
}

export const FEATURES = [
  // Reporting a loss months after it happened is the oldest signal there is.
  { name: 'days_loss_to_report', of: (r) => days(r.loss_date, r.opened_at) ?? 0 },
  // Delay measured against the norm for that line, not an absolute.
  {
    name: 'intimation_delay_ratio',
    of: (r) => {
      const delay = days(r.loss_date, r.opened_at)
      if (delay == null) return 0
      return Math.max(0, Math.min(30, delay / (INTIMATION_NORM_DAYS[r.claim_type] ?? 7)))
    },
  },
  // A loss immediately after the policy incepts, or before it, is abnormal.
  { name: 'days_inception_to_loss', of: (r) => days(r.effective_date, r.loss_date) ?? 365 },
  // Health claim inside the initial waiting period: payable only for accident.
  {
    name: 'within_health_waiting_period',
    of: (r) => {
      if (r.claim_type !== 'HEALTH') return 0
      const gap = days(r.effective_date, r.loss_date)
      return gap != null && gap >= 0 && gap <= HEALTH_INITIAL_WAITING_DAYS ? 1 : 0
    },
  },
  // Loss inside the free-look window, where the premium can still be refunded.
  {
    name: 'within_free_look',
    of: (r) => {
      const gap = days(r.effective_date, r.loss_date)
      return gap != null && gap >= 0 && gap <= FREE_LOOK_DAYS ? 1 : 0
    },
  },
  // Claiming in the last weeks of cover, before a renewal decision.
  {
    name: 'days_to_policy_expiry',
    of: (r) => {
      const left = days(r.loss_date, r.expiry_date)
      return left == null ? 365 : Math.max(-365, Math.min(365, left))
    },
  },
  { name: 'log_estimated_loss', of: (r) => Math.log1p(Math.max(0, num(r.estimated_loss) ?? 0)) },
  // Claiming close to the full sum insured is worth a look.
  {
    name: 'loss_to_sum_insured',
    of: (r) => {
      const sum = num(r.sum_insured)
      const loss = num(r.estimated_loss)
      return sum && sum > 0 && loss != null ? Math.min(5, loss / sum) : 0
    },
  },
  { name: 'amount_roundness', of: (r) => roundness(num(r.estimated_loss) ?? 0) },
  // Amounts parked just under a delegated-authority limit avoid senior review.
  // Structuring like this is deliberate, so proximity to a limit is the signal.
  {
    name: 'just_below_authority_limit',
    of: (r, stats) => {
      const loss = num(r.estimated_loss)
      const limits = stats?.authorityThresholds ?? []
      if (loss == null || !limits.length) return 0
      return limits.some((t) => t > 0 && loss <= t && loss >= 0.9 * t) ? 1 : 0
    },
  },
  { name: 'prior_claims', of: (r) => num(r.prior_claims) ?? 0 },
  { name: 'document_count', of: (r) => num(r.document_count) ?? 0 },
  {
    name: 'rejected_document_ratio',
    of: (r) => {
      const total = num(r.document_count) ?? 0
      return total > 0 ? (num(r.rejected_documents) ?? 0) / total : 0
    },
  },
  { name: 'policy_age_days_at_loss', of: (r) => Math.max(0, days(r.policy_created_at, r.loss_date) ?? 0) },
  { name: 'reopen_count', of: (r) => num(r.reopen_count) ?? 0 },
  { name: 'escalation_level', of: (r) => num(r.escalation_level) ?? 0 },
  { name: 'severity_ordinal', of: (r) => SEVERITY_ORDINAL[r.severity] ?? 0 },
  { name: 'is_possible_duplicate', of: (r) => (r.possible_duplicate_of ? 1 : 0) },
  // Monsoon (June-September). Genuine flood and water-damage claims cluster
  // here, so the model needs the season to avoid treating a normal monsoon
  // surge as anomalous. It lowers false positives more than it catches fraud.
  {
    name: 'monsoon_loss',
    of: (r) => {
      if (!r.loss_date) return 0
      const month = new Date(r.loss_date).getUTCMonth() + 1
      return month >= 6 && month <= 9 ? 1 : 0
    },
  },
  { name: 'report_hour', of: (r) => (r.opened_at ? new Date(r.opened_at).getUTCHours() : 12) },
  { name: 'is_weekend_report', of: (r) => (r.opened_at ? ([0, 6].includes(new Date(r.opened_at).getUTCDay()) ? 1 : 0) : 0) },
  // Links this to ring detection: how many entities share this building.
  { name: 'entities_at_premises', of: (r) => num(r.entities_at_premises) ?? 1 },
  // How unusual the amount is *for this line of business* — the only
  // comparison that means anything across MOTOR and HEALTH together.
  {
    name: 'amount_robust_z',
    of: (r, stats) => {
      const loss = num(r.estimated_loss)
      if (loss == null) return 0
      const s = stats?.byClaimType?.[r.claim_type] ?? stats?.overall
      if (!s) return 0
      return Math.max(-10, Math.min(10, (loss - s.median) / s.mad))
    },
  },
]

export const featureNames = FEATURES.map((f) => f.name)

/** Population statistics computed once over training rows and persisted with the model. */
export function buildPopulationStats(rows, { authorityThresholds = [] } = {}) {
  const amountsByType = {}
  for (const r of rows) {
    const loss = num(r.estimated_loss)
    if (loss == null) continue
    ;(amountsByType[r.claim_type] ||= []).push(loss)
  }
  const all = Object.values(amountsByType).flat()
  const overallMedian = median(all)
  const stats = {
    overall: { median: overallMedian, mad: mad(all, overallMedian) },
    byClaimType: {},
    authorityThresholds: [...new Set(authorityThresholds.map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b),
  }
  for (const [type, values] of Object.entries(amountsByType)) {
    // Too few observations to characterise a line; fall back to the whole book.
    if (values.length < 5) continue
    const m = median(values)
    stats.byClaimType[type] = { median: m, mad: mad(values, m) }
  }
  return stats
}

export function toVector(row, stats) {
  return FEATURES.map((f) => {
    const value = Number(f.of(row, stats))
    return Number.isFinite(value) ? value : 0
  })
}

/** Per-feature medians, used to neutralise a feature when explaining a score. */
export function featureMedians(vectors) {
  return featureNames.map((_, i) => median(vectors.map((v) => v[i])))
}
