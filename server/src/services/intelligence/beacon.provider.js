import { AI_AGENTS, EXTRACTABLE_CLAIM_FIELDS, humanize } from '../../../../shared/constants.js'
import { formatInr } from '../../utils/format.js'
import { readFileText, unreadableMessage } from './documentIntelligence.service.js'
import { extractIndianFields } from './indianFields.js'

/**
 * Beacon — HarborPoint's own claims intelligence.
 *
 * Named for what it does: a beacon guides a vessel, it does not steer it.
 * Every answer here is advisory, and a person with the matching permission
 * still applies or discards it — exactly the contract the model-backed
 * providers operate under.
 *
 * What this is: deterministic rules and arithmetic over facts the system has
 * already computed in SQL. What it is not: a language model. It generates no
 * prose it was not given a template for, and it cannot answer a question it
 * has no rule for — it says so instead.
 *
 * Why it can work at all: each agent's `prepare()` step already assembles the
 * decisive facts (policy clauses, adjuster workloads, comparable settlements,
 * payee signals). The model was only ever reasoning over that table. Where the
 * reasoning is arithmetic or lookup, a rule reproduces it exactly — and
 * reproducibly, which matters more than it sounds for a regulated file: the
 * same claim always yields the same recommendation, and every number traces to
 * a rule a person can audit.
 */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v))
const DAY = 86_400_000
const daysBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / DAY) : null)
const isoDay = (d) => new Date(d).toISOString().slice(0, 10)

/** Words that identify a peril, pulled from the claim's own classification. */
function perilTerms(loss = {}) {
  return [loss.loss_type, loss.claim_type, loss.affected_asset]
    .filter(Boolean)
    .flatMap((v) => String(v).toLowerCase().split(/[^a-z0-9]+/))
    .filter((t) => t.length > 2)
}

const scoreClause = (text, terms) => {
  const haystack = String(text ?? '').toLowerCase()
  return terms.reduce((n, term) => (haystack.includes(term) ? n + 1 : n), 0)
}

// ---------------------------------------------------------------------------
// 1. Coverage check
// ---------------------------------------------------------------------------
function coverageCheck(input) {
  const clauses = input.policy?.clauses ?? []
  const terms = perilTerms(input.loss)
  const hardPassed = input.hard_checks?.passed !== false

  const scored = clauses.map((c) => ({ ...c, score: scoreClause(c.text, terms) }))
  const covering = scored.filter((c) => c.type === 'COVERAGE' && c.score > 0).sort((a, b) => b.score - a.score)
  const exclusions = scored.filter((c) => c.type === 'EXCLUSION' && c.score > 0).sort((a, b) => b.score - a.score)
  const limits = scored.filter((c) => c.type === 'LIMIT')

  let result = 'NEEDS_REVIEW'
  const reasons = []
  if (!hardPassed) {
    reasons.push(`Policy checks failed: ${(input.hard_checks?.failed_reasons ?? []).join('; ')}`)
  } else if (exclusions.length && exclusions[0].score >= (covering[0]?.score ?? 0)) {
    result = 'NOT_COVERED'
    reasons.push(`Exclusion ${exclusions[0].id} matches the reported loss type.`)
  } else if (covering.length) {
    result = 'COVERED'
    reasons.push(`Coverage ${covering[0].id} matches the reported loss type.`)
  } else {
    reasons.push('No clause in the policy wording names this loss type, so a person must read the wording.')
  }

  // Matching clause text by keyword is a blunt instrument: it finds the clause
  // that mentions the peril, not the clause that governs it. Confidence is
  // capped below the agent's 0.8 auto-accept bar so every coverage call still
  // reaches a human.
  const confidence = covering.length || exclusions.length ? 0.6 : 0.3

  return {
    result,
    covering_clause_ids: covering.slice(0, 3).map((c) => c.id),
    exclusion_clause_ids: exclusions.slice(0, 3).map((c) => c.id),
    matched_perils: [...new Set(terms)].slice(0, 6),
    applicable_limit: num(input.policy?.sum_insured) ?? (limits.length ? null : null),
    deductible: num(input.policy?.deductible),
    rationale: `${reasons.join(' ')} Matched on the terms: ${[...new Set(terms)].slice(0, 6).join(', ') || 'none'}. This is a wording match, not a legal reading — confirm against the policy document.`,
    confidence,
    needs_human: true,
  }
}

// ---------------------------------------------------------------------------
// 2. Triage: severity, complexity, fraud score, routing
// ---------------------------------------------------------------------------
/** Thresholds arrive from segment config; shape is tolerated rather than assumed. */
function severityFor(amount, thresholds) {
  const entries = Object.entries(thresholds ?? {})
    .map(([band, value]) => [band.toUpperCase(), Number(value)])
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => a[1] - b[1])
  if (!entries.length || amount == null) return 'MEDIUM'
  let band = entries[0][0]
  for (const [name, threshold] of entries) if (amount >= threshold) band = name
  return ['LOW', 'MEDIUM', 'HIGH', 'CATASTROPHIC'].includes(band) ? band : 'MEDIUM'
}

function triage(input) {
  const loss = input.loss ?? {}
  const amount = num(loss.estimated_loss)
  const sumInsured = num(input.policy?.sum_insured)
  const severity = severityFor(amount, input.severity_thresholds)

  const prior = input.prior_claims_on_policy_24_months ?? []
  const documents = input.documents ?? []
  const rejected = documents.filter((d) => d.status === 'REJECTED').length

  // Complexity is a count of the things that make a file take longer, capped
  // to the scale the schema allows.
  let complexity = 1
  if (['HIGH', 'CATASTROPHIC'].includes(severity)) complexity += 1
  if (prior.length > 1) complexity += 1
  if (input.possible_duplicate || rejected > 0) complexity += 1
  complexity = clamp(complexity, 1, 4)

  // Only codes the database actually holds may be returned; the taxonomy is
  // passed in precisely so this provider cannot invent one.
  const available = new Set((input.fraud_reason_taxonomy ?? []).map((c) => c.code))
  const reasons = []
  const flag = (code, severityBand, explanation) => {
    if (available.has(code)) reasons.push({ code, severity: severityBand, explanation })
  }

  const reportDelay = loss.days_from_loss_to_report
  if (reportDelay != null && reportDelay > 30) {
    flag('LATE_NOTIFICATION', reportDelay > 90 ? 'HIGH' : 'MEDIUM', `Loss reported ${reportDelay} days after it occurred.`)
  }
  if (input.possible_duplicate) flag('DUPLICATE_SUSPECTED', 'HIGH', 'Another claim on file matches this loss.')
  if (amount != null && sumInsured && amount / sumInsured > 0.7) {
    flag('HIGH_VALUE', 'MEDIUM', `Claimed amount is ${Math.round((amount / sumInsured) * 100)}% of the sum insured.`)
  }
  const sinceInception = daysBetween(input.policy?.effective_date, loss.loss_date)
  if (sinceInception != null && sinceInception >= 0 && sinceInception <= 60) {
    flag('RAPID_CLAIM_AFTER_INCEPTION', 'MEDIUM', `Loss occurred ${sinceInception} days after the policy incepted.`)
  }
  if (!prior.length) flag('NO_TRADING_HISTORY', 'LOW', 'No prior claim history on this policy.')

  // The score is the sum of each matched code's weight scaled by its band —
  // the same arithmetic compliance.service.js already applies to flags a human
  // records, so a Beacon score and a staff-entered score are comparable.
  const weights = Object.fromEntries((input.fraud_reason_taxonomy ?? []).map((c) => [c.code, Number(c.weight) || 10]))
  const factor = { HIGH: 1, MEDIUM: 0.6, LOW: 0.3 }
  const fraudScore = clamp(
    Math.round(reasons.reduce((sum, r) => sum + (weights[r.code] ?? 10) * factor[r.severity], 0)),
    0,
    100,
  )

  // Routing: least-loaded adjuster, preferring one who has handled this claim
  // type before. Deterministic, so the same queue state always routes the same
  // way — and never uses anything resembling a protected attribute.
  const candidates = input.candidate_adjusters ?? []
  const ranked = [...candidates].sort((a, b) => {
    const experienceA = (a.claims_handled_by_type ?? {})[loss.claim_type] ?? 0
    const experienceB = (b.claims_handled_by_type ?? {})[loss.claim_type] ?? 0
    const loadA = (a.open_claims ?? 0) + (a.high_priority_open ?? 0) * 0.5
    const loadB = (b.open_claims ?? 0) + (b.high_priority_open ?? 0) * 0.5
    if (experienceA !== experienceB) return experienceB - experienceA
    return loadA - loadB
  })
  const pick = ranked[0] ?? null

  return {
    severity,
    complexity,
    fraud_score: fraudScore,
    fraud_reasons: reasons,
    recommended_adjuster: pick?.alias ?? null,
    routing_reason: pick
      ? `${pick.open_claims ?? 0} open claims, ${(pick.claims_handled_by_type ?? {})[loss.claim_type] ?? 0} previous ${loss.claim_type ?? ''} claims.`
      : 'No adjuster is available to route to.',
    rationale: `Severity ${severity} from the claimed amount against the segment thresholds; complexity ${complexity} from prior claims, duplicates and document rejections; risk score ${fraudScore} from ${reasons.length} matched indicator(s). Indicators are prompts for review, never a finding.`,
    confidence: 0.75,
  }
}

// ---------------------------------------------------------------------------
// 3. Reserve recommendation
// ---------------------------------------------------------------------------
const quantile = (sorted, q) => {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]
}

function reserve(input) {
  const lines = input.coverage_lines ?? []
  const comparables = input.comparable_settled_claims ?? []
  const paid = comparables.map((c) => Number(c.paid)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  const estimate = num(input.loss?.estimated_loss) ?? 0

  // Quantiles of what comparable claims actually settled at — the empirical
  // distribution of this book, not a guess. With too few comparables the
  // adjuster's own estimate is the honest fallback.
  const haveComparables = paid.length >= 3
  const low = haveComparables ? quantile(paid, 0.25) : estimate * 0.7
  const point = haveComparables ? quantile(paid, 0.5) : estimate
  const high = haveComparables ? quantile(paid, 0.75) : estimate * 1.3

  const evaluationValue = num(input.evaluation?.recommended_settlement)
  const centre = evaluationValue ?? point

  // The first coverage line carries the loss; any others are reserved
  // nominally until an adjuster apportions them.
  const out = lines.map((line, index) => ({
    coverage_line: line,
    low: Math.round(index === 0 ? low : low * 0.1),
    point: Math.round(index === 0 ? centre : centre * 0.1),
    high: Math.round(index === 0 ? high : high * 0.1),
    drivers: index === 0
      ? [
          haveComparables ? `Median of ${paid.length} settled ${input.loss?.claim_type ?? ''} claims` : 'Adjuster estimate (too few comparables)',
          evaluationValue ? 'Adjuster evaluation takes precedence over comparables' : 'No evaluation recorded yet',
        ]
      : ['Nominal until apportioned by the adjuster'],
  }))

  return {
    lines: out,
    comparables_used: haveComparables ? comparables.map((c) => c.alias).slice(0, 10) : [],
    rationale: haveComparables
      ? `Range taken from the 25th, 50th and 75th percentiles of ${paid.length} comparable settled claims. ${evaluationValue ? 'The point estimate follows the recorded evaluation rather than the median.' : ''}`
      : `Only ${paid.length} comparable settlement(s) on file — too few to form a distribution, so the range is set around the recorded estimate. Treat it as a placeholder.`,
    confidence: haveComparables ? 0.7 : 0.35,
  }
}

// ---------------------------------------------------------------------------
// 4. Denial letter
// ---------------------------------------------------------------------------
function denialLetter(input) {
  const clauses = input.policy_clauses ?? []
  const terms = perilTerms(input.loss)
  const cited = clauses
    .filter((c) => c.type === 'EXCLUSION' && scoreClause(c.text, terms) > 0)
    .slice(0, 2)
  const fallback = cited.length ? cited : clauses.filter((c) => c.type === 'EXCLUSION').slice(0, 1)
  const basis = (input.coverage_results ?? [])[0]?.notes || input.evaluation?.findings || 'the findings recorded on the claim file'

  // A fixed template rather than generated prose. For a regulator-facing
  // letter that is an advantage: the wording is reviewed once, and every
  // letter that goes out is identical apart from the facts.
  const body = [
    'Dear {{CLAIMANT_NAME}},',
    '',
    `We write regarding claim {{CLAIM_NUMBER}} under policy {{POLICY_NUMBER}}, reported on {{DATE}}.`,
    '',
    'We have completed our assessment of your claim. We regret to inform you that we are unable to admit it for payment.',
    '',
    `Our decision is based on ${basis}.`,
    fallback.length
      ? `The policy wording we have relied on is ${fallback.map((c) => `${c.id} (${c.text})`).join('; ')}.`
      : 'The policy wording relied on is recorded on your claim file.',
    '',
    'If you do not agree with this decision, you may ask us to review it. Please write to us with any further information or documents you would like us to consider, and we will reconsider the claim.',
    '',
    'If you remain dissatisfied, you may raise a grievance with our Grievance Redressal Officer. If your grievance is not resolved to your satisfaction, you may approach the Insurance Ombudsman for your region.',
    '',
    'Yours sincerely,',
    'Claims Department',
    'HarborPoint General Insurance',
  ].join('\n')

  return {
    subject: `Claim {{CLAIM_NUMBER}} — assessment outcome`,
    body,
    cited_clause_ids: fallback.map((c) => c.id),
    facts_relied_on: [
      input.evaluation?.decision ? `Evaluation decision: ${input.evaluation.decision}` : null,
      input.loss?.loss_type ? `Reported loss type: ${input.loss.loss_type}` : null,
      input.loss?.loss_date ? `Date of loss: ${isoDay(input.loss.loss_date)}` : null,
    ].filter(Boolean),
    missing_notice_language: fallback.length ? [] : ['No exclusion clause could be identified from the policy wording — insert the clause relied on before sending.'],
    confidence: fallback.length ? 0.6 : 0.3,
  }
}

// ---------------------------------------------------------------------------
// 5. Payee anomaly check
// ---------------------------------------------------------------------------
/** Wording here is deliberately plain. The agent discards any output that
 *  concludes fraud or recommends releasing or holding a payment, so these
 *  drafts describe the discrepancy and ask for a document. */
const PAYEE_DRAFTS = {
  NEW_BANK_DETAILS: 'No payment has been made to this payee before. Please ask for a cancelled cheque or recent bank statement showing the account name, so the details can be confirmed against the settlement record.',
  RECENT_BANK_CHANGE: 'The bank details were changed recently. Please confirm the change directly with the policyholder using the contact number already on file, rather than any number supplied with the change request.',
  NAME_MISMATCH: 'The payee name does not match the insured or claimant name on the claim. Please ask for documentation showing the relationship between the two parties.',
  DUPLICATE_PAYEE: 'Another payee record uses the same bank account. Please ask the owner of this record to confirm which claimant the account belongs to.',
  PAYEE_ON_MULTIPLE_CLAIMS: 'This payee appears on more than one claim. Please ask for confirmation that each claim relates to a separate loss.',
  THIRD_PARTY_PAYEE: 'The payee is not the policyholder. Please ask for the assignment or authority under which settlement is to be made to this party.',
}

const PAYEE_EVIDENCE = {
  NEW_BANK_DETAILS: (f) => `No prior payments recorded to this payee (${f.prior_payments_to_payee ?? 0}).`,
  RECENT_BANK_CHANGE: (f) => `Bank details changed ${f.days_since_bank_change} day(s) ago${f.bank_changed_after_last_payment ? ', after the last payment was made' : ''}.`,
  NAME_MISMATCH: (f) => `Payee "${f.payee?.name}" differs from insured "${f.insured_name}" and claimant "${f.claimant_name ?? 'not recorded'}".`,
  DUPLICATE_PAYEE: (f) => `${f.other_payees_with_same_account} other payee record(s) share this account number.`,
  PAYEE_ON_MULTIPLE_CLAIMS: (f) => `${f.other_claims_paying_this_payee} other claim(s) pay this payee.`,
  THIRD_PARTY_PAYEE: () => 'The payee record is not linked to the policyholder.',
}

const normalizeName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function payeeAnomaly(input) {
  const approved = new Set(input.approved_codes ?? [])
  const found = []
  const add = (code) => {
    if (approved.has(code) && !found.includes(code)) found.push(code)
  }

  if (!input.prior_payments_to_payee) add('NEW_BANK_DETAILS')
  const sinceChange = input.days_since_bank_change
  if (input.bank_changed_after_last_payment || (sinceChange != null && sinceChange <= 30)) add('RECENT_BANK_CHANGE')
  if ((input.other_payees_with_same_account ?? 0) > 0) add('DUPLICATE_PAYEE')
  if ((input.other_claims_paying_this_payee ?? 0) > 0) add('PAYEE_ON_MULTIPLE_CLAIMS')
  if (input.payee_belongs_to_policyholder === false) add('THIRD_PARTY_PAYEE')

  const payeeName = normalizeName(input.payee?.name)
  const insured = normalizeName(input.insured_name)
  const claimant = normalizeName(input.claimant_name)
  if (payeeName && insured && payeeName !== insured && (!claimant || payeeName !== claimant)) add('NAME_MISMATCH')

  const anomalies = found.map((code) => ({
    code,
    evidence: PAYEE_EVIDENCE[code]?.(input) ?? 'Computed from the payee record.',
    draft_request: PAYEE_DRAFTS[code] ?? 'Please confirm this payee detail before the settlement is processed.',
  }))

  return {
    anomalies,
    summary: anomalies.length
      ? `${anomalies.length} payee detail(s) need confirmation before settlement: ${anomalies.map((a) => a.code.replace(/_/g, ' ').toLowerCase()).join(', ')}.`
      : 'The payee record matches the claim and the prior payment history. Nothing needs confirming.',
    // Every signal is computed from stored facts, not inferred, so there is no
    // uncertainty to discount.
    confidence: 0.95,
  }
}

// ---------------------------------------------------------------------------
// 6. Subrogation and salvage
// ---------------------------------------------------------------------------
function subrogation(input) {
  const parties = (input.other_parties ?? []).filter((p) => p.party_type === 'THIRD_PARTY' || p.role_in_loss)
  const documents = input.documents_on_file ?? []
  const hasPoliceReport = documents.includes('POLICE_REPORT')
  const paid = Number(input.amount_paid) || 0

  const thirdParties = parties.slice(0, 5).map((p) => ({
    party: p.name ?? 'Unnamed party',
    basis: p.role_in_loss ? `Recorded on the claim as: ${p.role_in_loss}` : 'Recorded as a third party to the loss',
    evidence: hasPoliceReport ? 'A police report is on file.' : 'No police report on file — evidence rests on the claim statements.',
  }))

  // Likelihood follows the two things that actually decide a recovery: an
  // identified counterparty, and documentary evidence against them.
  let likelihood = 'LOW'
  if (thirdParties.length && hasPoliceReport) likelihood = 'HIGH'
  else if (thirdParties.length) likelihood = 'MEDIUM'

  const salvage = ['MOTOR', 'PROPERTY'].includes(input.loss?.claim_type) && paid > 0
    ? [{ item: input.loss?.affected_asset ?? 'Damaged property', note: 'Inspect for residual value before the file is closed.' }]
    : []

  const recommendedType = thirdParties.length ? 'SUBROGATION' : salvage.length ? 'SALVAGE' : 'NONE'

  // Date arithmetic from the jurisdiction table the agent supplies — never a
  // period recalled from anywhere else.
  const years = Number(input.jurisdiction_table?.[0]?.years) || null
  let deadline = null
  let referralBy = null
  if (years && input.loss?.loss_date) {
    const d = new Date(input.loss.loss_date)
    d.setUTCFullYear(d.getUTCFullYear() + years)
    deadline = isoDay(d)
    const referral = new Date(d.getTime() - 180 * DAY)
    referralBy = isoDay(referral)
  }

  return {
    recovery_likelihood: likelihood,
    recommended_type: recommendedType,
    third_parties: thirdParties,
    salvage_items: salvage,
    limitation_deadline: deadline,
    referral_by: referralBy,
    rationale: `${thirdParties.length} identified third part(y/ies); police report ${hasPoliceReport ? 'on file' : 'not on file'}; ${paid > 0 ? `₹${paid.toLocaleString('en-IN')} paid to date` : 'nothing paid yet'}. ${deadline ? `Limitation runs to ${deadline} under the period given; refer by ${referralBy} to leave time to file.` : 'No limitation period could be derived — confirm with Legal.'}`,
    confidence: thirdParties.length ? 0.65 : 0.4,
  }
}

// ---------------------------------------------------------------------------
// 7. Document extraction (intake parser)
// ---------------------------------------------------------------------------
// No model reads the file. Our own pipeline does: the PDF text layer, or our
// OCR for a photograph, then the statutory Indian formats and labelled lines
// (indianFields.js). It finds what is printed in a recognisable form, never
// guesses what is not, and says so when a file cannot be read.
const EXTRACT_KEYS = EXTRACTABLE_CLAIM_FIELDS.map((f) => f.key)

function intakeParser(input) {
  const { data, mimeType, docTypeLabel, claimType } = input
  const read = data ? readFileText(Buffer.from(data, 'base64'), mimeType) : { text: '', hasTextLayer: false, reason: null }
  const empty = () => ({ value: null, confidence: 0, page: null, quote: null })
  const fields = Object.fromEntries(EXTRACT_KEYS.map((k) => [k, empty()]))

  if (!read.hasTextLayer) {
    return { document_type: docTypeLabel || 'Unknown', fields, notes: [unreadableMessage(read.reason, read.quality)] }
  }

  // Values from a real text layer are firmer than OCR'd ones. Both stay below the
  // 0.8 bar, so a person confirms every value against the source.
  const firm = read.source === 'OCR' ? 0.6 : 0.7
  const loose = read.source === 'OCR' ? 0.3 : 0.4
  const { identifiers, fields: found } = extractIndianFields(read.text)
  for (const key of EXTRACT_KEYS) {
    const raw = found[key]
    if (raw == null) continue
    const value = typeof raw === 'object' ? raw.value : raw
    fields[key] = {
      value: value == null ? null : String(value),
      confidence: typeof raw === 'object' && raw.confident === false ? loose : firm,
      page: null,
      quote: typeof raw === 'object' ? raw.evidence ?? null : null,
    }
  }
  // A motor document's registration number identifies the asset.
  const vehicle = identifiers.find((i) => i.type === 'vehicle')
  if (!fields.affected_asset.value && vehicle && claimType === 'MOTOR') {
    fields.affected_asset = { value: `Vehicle ${vehicle.value}`, confidence: loose, page: null, quote: vehicle.value }
  }

  const notes = [`Read by Beacon from the ${read.source === 'OCR' ? 'image using our own OCR' : "PDF's text layer"}; no language model was used.`]
  // PIN codes are left out: any six digits match, including ones inside a policy number.
  const shown = identifiers.filter((i) => i.type !== 'pincode')
  if (shown.length) notes.push(`Identifiers found: ${shown.map((i) => `${i.label} ${i.value}`).join(', ')}.`)
  const missing = EXTRACT_KEYS.filter((k) => !fields[k].value)
  if (missing.length) notes.push(`Not found in a recognisable form: ${missing.map((k) => k.replace(/_/g, ' ')).join(', ')}. Check the document by eye.`)
  return { document_type: docTypeLabel || 'Unknown', fields, notes }
}

// ---------------------------------------------------------------------------
// 8. Claim summary
// ---------------------------------------------------------------------------
// Fixed sentences filled from the recorded facts the server already gathered
// (factsForModel in ai-automation.service.js). Every statement traces to a
// field; nothing is inferred, and no decision or fraud language is produced.
// Mid-sentence wording of a code ("PROOF_OF_LOSS" -> "proof of loss"), from the shared humanize.
const words = (s) => humanize(s).toLowerCase()
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null)
const rupees = (n) => (n == null ? null : formatInr(n))
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const describe = (m) => (typeof m === 'string' ? m : m?.description || m?.label || words(m?.doc_type) || 'an item')

function claimSummary(input) {
  const { claim = {}, loss = {}, documentsReceived = [], missingInformation = [], pendingActions = [] } = input
  const sentences = []
  sentences.push(`${words(claim.claim_type).replace(/^./, (c) => c.toUpperCase())} claim${loss.type ? ` (${words(loss.type)})` : ''}, currently ${words(claim.status)}${claim.opened_at ? `, opened ${day(claim.opened_at)}` : ''}.`)
  const lossBits = [loss.occurred_at && `on ${day(loss.occurred_at)}`, loss.location && `at ${loss.location}`, loss.affected_asset && `involving ${loss.affected_asset}`].filter(Boolean)
  if (lossBits.length || loss.estimated_loss != null) {
    sentences.push(`Loss reported ${lossBits.join(', ')}${loss.estimated_loss != null ? `${lossBits.length ? ';' : ''} estimated loss ${rupees(loss.estimated_loss)}` : ''}.`)
  }
  const byStatus = {}
  for (const d of documentsReceived) byStatus[d.status] = (byStatus[d.status] || 0) + 1
  sentences.push(documentsReceived.length
    ? `${plural(documentsReceived.length, 'document')} received: ${Object.entries(byStatus).map(([s, n]) => `${n} ${words(s)}`).join(', ')}.`
    : 'No documents received yet.')
  sentences.push(missingInformation.length ? `Missing: ${missingInformation.map(describe).join('; ')}.` : 'Nothing is recorded as missing.')
  const overdue = pendingActions.filter((a) => a.overdue)
  sentences.push(pendingActions.length
    ? `${plural(pendingActions.length, 'pending action')}${overdue.length ? `, ${overdue.length} overdue` : ', none overdue'}.`
    : 'No pending actions.')
  if (claim.due_date) sentences.push(claim.overdue ? `The claim is past its stage due date (${day(claim.due_date)}).` : `Stage due ${day(claim.due_date)}.`)

  const actions = []
  for (const a of overdue) actions.push({ action: `Complete the overdue action: ${a.description}`, reason: `It was due ${day(a.due_at)}.` })
  const awaiting = documentsReceived.filter((d) => /PENDING|UPLOADED|RECEIVED/.test(d.status))
  if (awaiting.length) actions.push({ action: `Review the ${plural(awaiting.length, 'document')} awaiting review`, reason: `${awaiting.map((d) => words(d.doc_type)).join(', ')} not yet accepted or rejected.` })
  if (missingInformation.length) actions.push({ action: 'Request the missing information from the claimant', reason: `Recorded as missing: ${missingInformation.map(describe).join('; ')}.` })
  const next = pendingActions.find((a) => !a.overdue)
  if (next && actions.length < 5) actions.push({ action: next.description, reason: next.due_at ? `Due ${day(next.due_at)}.` : 'Open on the claim.' })

  const points = []
  if (!loss.description || loss.description.trim().length < 60) points.push('The loss description is brief. Confirm the sequence of events with the claimant.')
  if (loss.estimated_loss == null) points.push('No estimated loss is recorded.')
  if (loss.occurred_at && claim.opened_at && new Date(claim.opened_at) - new Date(loss.occurred_at) > 30 * DAY) {
    points.push(`The claim was opened ${daysBetween(loss.occurred_at, claim.opened_at)} days after the loss. Check the notification terms in the policy.`)
  }
  const rejected = documentsReceived.filter((d) => d.status === 'REJECTED')
  if (rejected.length) points.push(`${plural(rejected.length, 'document')} rejected: ${rejected.map((d) => words(d.doc_type)).join(', ')}. Check a replacement was requested.`)

  return { summary: sentences.join(' '), suggested_next_actions: actions.slice(0, 5), points_to_verify: points.slice(0, 5) }
}

const HANDLERS = {
  [AI_AGENTS.INTAKE_PARSER]: intakeParser,
  [AI_AGENTS.CLAIM_SUMMARIZER]: claimSummary,
  [AI_AGENTS.COVERAGE_CHECKER]: coverageCheck,
  [AI_AGENTS.TRIAGE_ROUTER]: triage,
  [AI_AGENTS.RESERVE_RECOMMENDER]: reserve,
  [AI_AGENTS.DENIAL_DRAFTER]: denialLetter,
  [AI_AGENTS.PAYEE_ANOMALY]: payeeAnomaly,
  [AI_AGENTS.SUBROGATION_ASSESSOR]: subrogation,
}

export const BEACON_AGENTS = Object.keys(HANDLERS)

/**
 * Provider for AI_PROVIDER=local. Same interface as the Anthropic and Ollama
 * providers, so nothing upstream knows the difference.
 */
export function createBeaconProvider({ aiError }) {
  return {
    name: 'beacon',
    model: 'beacon-rules/2026-10-29',
    configured: true,
    async generateJson({ agent, input }) {
      const handler = HANDLERS[agent]
      if (!handler) {
        // Every agent in AI_AGENTS has a rule; this only catches an agent added
        // later without one. Saying so beats returning something empty that
        // looks like an answer.
        throw aiError(
          501,
          'AI_AGENT_UNSUPPORTED',
          `Beacon has no rules for "${agent}". It covers ${BEACON_AGENTS.join(', ')}. Agents that read free text need a language model — set AI_PROVIDER=anthropic or ollama for those.`,
        )
      }
      const started = Date.now()
      const data = handler(input ?? {})
      return {
        data,
        model: `beacon/${agent}`,
        usage: { inputTokens: null, outputTokens: null, durationMs: Date.now() - started },
      }
    },
  }
}
