import { extractAmount, parseIndianDate } from './indianFields.js'

/*
 * Beacon claim-relevance check — is this upload evidence for the claim at all?
 *
 * Runs locally on the text Beacon already read (PDF text layer or our own OCR):
 * insurance/claim vocabulary, a recognisable date or amount, or the claim's own
 * insured name, policy number, claim number or loss location. A file of a type
 * that should carry printed text (bill, estimate, report, form) that shows none
 * of these is marked IRRELEVANT, so a reviewer can reject it in one click and
 * it is never escalated as fraud (a wallpaper or meme saved on two claims is
 * not a duplicate-evidence scheme).
 *
 * Deliberately conservative:
 *   - Photos, ID proofs and staff-internal files are not judged: a genuine
 *     damage photograph or ID card has no bill text, and our OCR cannot tell a
 *     dented bumper from a holiday snap.
 *   - A file Beacon cannot open (corrupt, WebP, too large, a scanned PDF with
 *     no text layer) is UNKNOWN, not IRRELEVANT.
 * IRRELEVANT is an indicator for the reviewer, never an automatic rejection.
 */

export const RELEVANCE = Object.freeze({ RELEVANT: 'RELEVANT', IRRELEVANT: 'IRRELEVANT', UNKNOWN: 'UNKNOWN' })
export const RELEVANCE_STATUSES = Object.values(RELEVANCE)

export const IRRELEVANT_TITLE = 'Unnecessary / Unrelated Document'
export const IRRELEVANT_EVIDENCE = 'Beacon AI found no invoice, medical, repair, or policy details matching this claim.'
/** Rejection reason used by the one-click reject in the UI (also accepted by the review endpoint). */
export const IRRELEVANT_REJECTION_REASON = 'Unnecessary / unrelated document flagged by Beacon AI'

/** Document types that are photographs or identity documents by nature, or internal to staff. */
export const RELEVANCE_NOT_ASSESSED_TYPES = ['PHOTOS', 'ID_PROOF', 'INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE', 'DENIAL_LETTER']

// Read reasons that mean "we could not open or read the file at all", as
// opposed to "we looked and found nothing about the claim".
const CANNOT_JUDGE_REASONS = new Set(['IMAGE_DECODE_FAILED', 'SCANNED_NEEDS_OCR', 'PDF_PARSE_FAILED', 'UNSUPPORTED_FORMAT', 'TOO_LARGE', 'READ_FAILED'])

const DOMAIN_TERMS = [
  'total', 'amount', 'bill', 'billing', 'invoice', 'receipt', 'hospital', 'medical', 'discharge', 'repair', 'repairs',
  'estimate', 'police', 'fir', 'policy', 'claim', 'claims', 'insurance', 'insured', 'rs', 'inr', 'patient', 'diagnosis',
  'garage', 'workshop', 'gst', 'gstin', 'premium', 'surveyor', 'accident',
]
const TERM_RES = DOMAIN_TERMS.map((t) => ({ term: t, re: new RegExp(`(?:^|[^a-z0-9])${t}(?:[^a-z0-9]|$)`, 'i') }))

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Name/location words worth matching: four letters or more, so "the", "rd", "ltd" never count. */
const words = (s) => [...new Set(norm(s).split(' ').filter((w) => w.length >= 4 && !/^\d+$/.test(w)))]

function claimMatches(text, claim = {}, policy = null) {
  const hay = ` ${norm(text)} `
  const compact = hay.replace(/ /g, '')
  const found = []
  const numbers = [
    ['policy number', policy?.external_policy_no],
    ['claim number', claim.claim_number],
  ]
  for (const [label, value] of numbers) {
    const v = norm(value).replace(/ /g, '')
    if (v.length >= 5 && compact.includes(v)) found.push(label)
  }
  const nameWords = words(policy?.insured_name || claim.insured_name)
  if (nameWords.some((w) => hay.includes(` ${w} `))) found.push('insured name')
  const placeWords = words([claim.loss_location, claim.loss_city].filter(Boolean).join(' '))
  if (placeWords.some((w) => hay.includes(` ${w} `))) found.push('loss location')
  return found
}

/**
 * The relevance signals in a piece of text. Pure; exported for tests.
 * Returns the matched terms (at most 8) and whether a date or amount appeared.
 */
export function relevanceSignals(text, { claim = {}, policy = null } = {}) {
  const t = String(text ?? '')
  const signals = []
  for (const { term, re } of TERM_RES) if (re.test(t)) signals.push(term)
  if (/₹/.test(t)) signals.push('₹')
  let hasDate = false
  let hasAmount = false
  try {
    hasDate = t.split('\n').some((l) => parseIndianDate(l))
    hasAmount = Boolean(extractAmount(t))
  } catch {
    // A parser hiccup on odd text is not a reason to fail the scan.
  }
  if (hasDate) signals.push('a date')
  if (hasAmount) signals.push('an amount')
  signals.push(...claimMatches(t, claim, policy))
  return [...new Set(signals)].slice(0, 8)
}

/**
 * Judges one file from what was read from it.
 *
 * @param read     the result of readFileText (or equivalent): { text, hasTextLayer, reason }
 * @param docType  the document type it was filed as
 * @returns {{ status, title, evidence, signals, detail }}
 */
export function assessRelevance({ read, docType, claim = {}, policy = null }) {
  const base = { title: null, evidence: null, signals: [], detail: null }
  if (RELEVANCE_NOT_ASSESSED_TYPES.includes(docType)) {
    return { ...base, status: RELEVANCE.UNKNOWN, detail: 'Photos, ID proofs and internal files are not judged for relevance.' }
  }
  if (!read || CANNOT_JUDGE_REASONS.has(read.reason)) {
    return { ...base, status: RELEVANCE.UNKNOWN, detail: 'The file could not be read, so its relevance was not judged.' }
  }
  // Only text Beacon read with confidence counts: low-confidence OCR output is
  // noise, and noise can contain "RS" or something that looks like a date.
  const signals = read.hasTextLayer ? relevanceSignals(read.text, { claim, policy }) : []
  if (signals.length) return { ...base, status: RELEVANCE.RELEVANT, signals }

  const detail = read.hasTextLayer
    ? 'Beacon read the text in this file, and none of it relates to an insurance claim.'
    : read.reason === 'IMAGE_UNREADABLE'
      ? 'No legible text: the image is blank, very dark or blurred. If it is a genuine bill or report, ask for a clearer copy.'
      : 'No legible bill, report or form text was found in this file.'
  return { ...base, status: RELEVANCE.IRRELEVANT, title: IRRELEVANT_TITLE, evidence: IRRELEVANT_EVIDENCE, detail }
}
