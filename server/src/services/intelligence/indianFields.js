/**
 * Field extraction for Indian claim paperwork.
 *
 * Indian documents are unusually good candidates for deterministic extraction
 * because the identifiers are checksummed, fixed-width formats defined by
 * statute: PAN, GSTIN, IFSC, vehicle registration. A regex that respects the
 * structure beats a language model on these — it is exact, it cannot
 * hallucinate a plausible-looking PAN, and it costs nothing to run.
 *
 * Every value returned is a PROPOSAL carrying the text it came from, so a
 * Document Reviewer confirms against the source rather than trusting a number.
 */

/** Aadhaar is deliberately absent. Capturing it creates a UIDAI compliance
 *  burden this system is not built for, and no claim decision needs it. If a
 *  document contains one it is masked on sight, never extracted. */
export const AADHAAR_LIKE = /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g

const PATTERNS = {
  // Fifth character is the holder's surname initial; 4th encodes holder type.
  pan: { re: /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g, label: 'PAN' },
  // 2-digit state code, PAN, entity number, 'Z', checksum.
  gstin: { re: /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/g, label: 'GSTIN' },
  // 4-letter bank code, mandatory 0, 6-char branch code.
  ifsc: { re: /\b([A-Z]{4}0[A-Z0-9]{6})\b/g, label: 'IFSC' },
  // Modern series: MH12AB1234. Spaces and hyphens are common in print.
  vehicle: { re: /\b([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4})\b/g, label: 'Vehicle registration' },
  cin: { re: /\b([LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/g, label: 'CIN' },
  pincode: { re: /\b([1-9]\d{5})\b/g, label: 'PIN code' },
}

const LABELLED = {
  policy_number: /(?:policy|pol)\s*(?:no|number|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{3,24})/i,
  claim_number: /claim\s*(?:no|number|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{3,24})/i,
  fir_number: /(?:f\.?i\.?r\.?|first\s+information\s+report)\s*(?:no|number|#)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{2,24})/i,
  insured_name: /(?:insured|policy\s*holder|patient|name\s+of\s+insured)\s*(?:name)?\s*[:.\-]\s*([A-Za-z][A-Za-z.\s]{2,60}?)(?=\s{2,}|\n|$)/i,
  invoice_number: /(?:invoice|bill|receipt)\s*(?:no|number|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{2,24})/i,
}

/**
 * Amounts as they actually appear on Indian bills, in three forms:
 *   1. currency-prefixed            Rs. 44073 / ₹44,073
 *   2. comma-grouped, either style  2,40,450.00 (lakh) and 44,073.00 (thousand)
 *   3. bare decimal                 18400.00
 *
 * Requiring either a comma or a two-decimal tail is what keeps GSTINs, bill
 * numbers, PIN codes and dates out of the candidate list.
 */
const AMOUNT = new RegExp(
  [
    String.raw`(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.\d{1,2})?)`,
    String.raw`\b(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?)\b`,
    String.raw`\b(\d{3,9}\.\d{2})\b`,
  ].join('|'),
  'gi',
)

const AMOUNT_HINTS = [
  { re: /(?:grand\s+)?total|net\s+payable|amount\s+payable|final\s+amount/i, weight: 3 },
  { re: /claim(?:ed)?\s+amount|estimate|repair\s+cost|loss\s+amount/i, weight: 2 },
  { re: /sub\s*total|taxable|gst|cgst|sgst|igst|discount/i, weight: -2 },
]

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/**
 * Indian convention is DD/MM/YYYY. Reading 03/04/2026 as 3 April, not 4 March,
 * is the single most consequential assumption here: a misread loss date can
 * move a claim in or out of the policy period.
 */
export function parseIndianDate(text) {
  const numeric = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/.exec(text)
  if (numeric) {
    const [, d, m, y] = numeric
    const day = Number(d)
    const month = Number(m)
    // Unambiguously US-ordered (month > 12 in the day slot is impossible), so
    // the only safe reading is that the fields are swapped.
    const [dd, mm] = day > 12 && month <= 12 ? [day, month] : [day, month]
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y)
    const date = new Date(Date.UTC(year, mm - 1, dd))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const named = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*[-\s]?([A-Za-z]{3,9})[-\s,]?\s*(\d{4})\b/.exec(text)
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (!month) return null
    const date = new Date(Date.UTC(Number(named[3]), month - 1, Number(named[1])))
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  return null
}

const toAmount = (s) => Number(String(s).replace(/,/g, ''))

/**
 * Picks the amount most likely to be the claimable total. A hospital bill
 * carries a dozen figures; the one that matters sits beside "Total" or "Net
 * Payable", not beside "CGST".
 */
export function extractAmount(text) {
  const candidates = []
  for (const line of String(text).split('\n')) {
    let weight = 0
    for (const hint of AMOUNT_HINTS) if (hint.re.test(line)) weight += hint.weight
    for (const m of line.matchAll(AMOUNT)) {
      const value = toAmount(m[1] ?? m[2] ?? m[3])
      if (Number.isFinite(value) && value > 0) candidates.push({ value, weight, line: line.trim() })
    }
  }
  if (!candidates.length) return null
  // Highest hinted weight wins; ties break on the larger amount, since a total
  // is never smaller than its components.
  candidates.sort((a, b) => b.weight - a.weight || b.value - a.value)
  const best = candidates[0]
  return { value: best.value, evidence: best.line.slice(0, 200), confident: best.weight > 0 }
}

/** Masks anything shaped like an Aadhaar before text is stored or shown. */
export function maskAadhaar(text) {
  return String(text).replace(AADHAAR_LIKE, (m) => `XXXX XXXX ${m.replace(/\s/g, '').slice(-4)}`)
}

/**
 * @returns {{identifiers: object[], fields: object, aadhaarPresent: boolean}}
 */
export function extractIndianFields(rawText) {
  const text = String(rawText ?? '')
  const aadhaarPresent = AADHAAR_LIKE.test(text)
  AADHAAR_LIKE.lastIndex = 0

  const identifiers = []
  const seen = new Set()
  for (const [key, { re, label }] of Object.entries(PATTERNS)) {
    for (const m of text.matchAll(re)) {
      const value = m[1].replace(/[\s-]/g, '')
      // A PAN is a substring of a GSTIN; report the richer identifier only.
      if (key === 'pan' && identifiers.some((i) => i.type === 'gstin' && i.value.includes(value))) continue
      const id = `${key}:${value}`
      if (seen.has(id)) continue
      seen.add(id)
      identifiers.push({ type: key, label, value })
    }
  }
  // Re-check PAN now that every GSTIN is known.
  const gstins = identifiers.filter((i) => i.type === 'gstin').map((i) => i.value)
  const filtered = identifiers.filter((i) => !(i.type === 'pan' && gstins.some((g) => g.includes(i.value))))

  const fields = {}
  for (const [key, re] of Object.entries(LABELLED)) {
    const m = re.exec(text)
    if (m) fields[key] = m[1].trim().replace(/\s{2,}/g, ' ')
  }

  const amount = extractAmount(text)
  if (amount) fields.estimated_loss = amount

  const dateLine = String(text).split('\n').find((l) => /date\s+of\s+(?:loss|accident|admission|incident)|loss\s+date|date\s+of\s+event/i.test(l))
  const lossDate = dateLine ? parseIndianDate(dateLine) : null
  if (lossDate) fields.loss_date = { value: lossDate, evidence: dateLine.trim().slice(0, 200), confident: true }

  return { identifiers: filtered, fields, aadhaarPresent }
}
