import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readFileText } from './documentIntelligence.service.js'
import { extractAmount, parseIndianDate } from './indianFields.js'

/**
 * Beacon image forensics — zero-cost, fully local checks on claim photos and
 * photographed receipts. No model, no network call, no paid API:
 *
 *   1. Cross-claim duplicate: the exact same file (SHA-256 of the bytes) is
 *      stored on another claim.
 *   2. Metadata tampering: the raw bytes carry an editing-software or
 *      generative-AI signature, an edit history, or a capture date earlier
 *      than the date of loss.
 *   3. OCR mismatch: our own OCR reads the bill total and date, and they
 *      disagree with the claimed amount or predate the loss.
 *
 * Every result is an INDICATOR for a person to review, never a finding. A
 * person accepts an alert before anything is recorded on the claim.
 */

export const IMAGE_FORENSICS_ENGINE = 'beacon-image-forensics/2026-11-16'
/** ai_runs.agent for a forensics scan recorded from the document view. */
export const IMAGE_FORENSICS_AGENT = 'image-forensics'
/** applied_fields marker on a run whose image alert a person accepted. */
export const IMAGE_ALERT_APPLIED = 'image_fraud_alert'

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const isImageMime = (mime) => IMAGE_MIME_TYPES.includes(mime)

/** The image codec handles PNG and baseline JPEG; WebP gets checks 1 and 2 only. */
const OCR_MIME_TYPES = ['image/png', 'image/jpeg']
/** Pure-JS decode + OCR of a very large photograph is slow; above this, OCR is skipped and said so. */
const OCR_MAX_BYTES = 6 * 1024 * 1024
/** Bytes inspected for metadata at each end of the file (EXIF/XMP live at the start, some writers append XMP). */
const METADATA_WINDOW = 65536
/** A bill total within this fraction of the claimed amount is treated as matching. */
const AMOUNT_TOLERANCE = 0.1
const MAX_IMAGES_PER_CLAIM = 12
/**
 * Below this size an "image" is a placeholder (a blank or 1×1 file), not a
 * photograph or receipt: identical placeholders on many claims say nothing
 * about fraud, so they are not reported as duplicates.
 */
export const MIN_DUPLICATE_BYTES = 2048

export const CHECK_TYPES = [
  'DUPLICATE_IMAGE',
  'EDITING_SOFTWARE',
  'AI_GENERATED',
  'MODIFIED_AFTER_CAPTURE',
  'CAPTURED_BEFORE_LOSS',
  'AMOUNT_MISMATCH',
  'BILL_DATE_BEFORE_LOSS',
]
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH']

/**
 * Fraud reason codes per check, most specific first. The specific codes come
 * from migration 20261116000018; the fallbacks exist in every schema, so an
 * imported database without that migration still records a flag.
 */
export const CHECK_REASON_CODES = {
  DUPLICATE_IMAGE: ['DUPLICATE_DOCUMENT_IMAGE', 'DUPLICATE_SUSPECTED'],
  EDITING_SOFTWARE: ['DOCUMENT_TAMPERING', 'FRAUD_INDICATOR'],
  AI_GENERATED: ['DOCUMENT_TAMPERING', 'FRAUD_INDICATOR'],
  MODIFIED_AFTER_CAPTURE: ['DOCUMENT_TAMPERING', 'FRAUD_INDICATOR'],
  CAPTURED_BEFORE_LOSS: ['IMAGE_PREDATES_LOSS', 'INCONSISTENT_STATEMENTS'],
  AMOUNT_MISMATCH: ['INCONSISTENT_STATEMENTS'],
  BILL_DATE_BEFORE_LOSS: ['INCONSISTENT_STATEMENTS'],
}

// ---------------------------------------------------------------------------
// Output contract (validated before it is stored or shown)
// ---------------------------------------------------------------------------
export const imageFraudCheckSchema = z.object({
  check: z.enum(CHECK_TYPES),
  code: z.string().min(1).max(60),
  severity: z.enum(RISK_LEVELS),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1).max(600),
  matchedClaimNumber: z.string().max(60).nullable(),
})

export const imageFraudAlertSchema = z.object({
  documentId: z.string().uuid(),
  fileName: z.string().max(300),
  docType: z.string().max(60).nullable(),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  riskLevel: z.enum(RISK_LEVELS),
  confidence: z.number().min(0).max(1),
  matchedClaimNumber: z.string().max(60).nullable(),
  matchedClaims: z
    .array(z.object({ claimNumber: z.string().max(60).nullable(), documentId: z.string().uuid(), fileName: z.string().max(300) }))
    .max(10),
  evidence: z.array(z.string().max(600)).min(1).max(20),
  checks: z.array(imageFraudCheckSchema).min(1).max(20),
  ocr: z.object({
    read: z.boolean(),
    amount: z.number().nullable(),
    billDate: z.string().nullable(),
    note: z.string().max(300).nullable(),
  }),
  engine: z.string().max(80),
  scannedAt: z.string().max(40),
})

export const imageFraudAlertsSchema = z.array(imageFraudAlertSchema).max(MAX_IMAGES_PER_CLAIM)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DAY = 86_400_000
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null)
const dayStart = (d) => {
  const x = new Date(d)
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
}
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const round3 = (n) => Math.round(n * 1000) / 1000

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Latin1 view of the regions of the file where metadata lives. */
export function metadataText(buffer) {
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, METADATA_WINDOW))
  if (buffer.length <= METADATA_WINDOW) return head
  return `${head}\n${buffer.toString('latin1', Math.max(METADATA_WINDOW, buffer.length - METADATA_WINDOW))}`
}

/*
 * Signatures are specific product names rather than bare words: a bare "AI" or
 * "Modified" matches random bytes inside compressed image data and would flag
 * nearly every photograph. Edit history is detected structurally instead
 * (XMP ModifyDate after CreateDate, or an XMP history of save/convert events).
 */
const EDITOR_SIGNATURES = [
  // Version and platform only, e.g. "Adobe Photoshop 25.4 (Windows)" — not the binary that follows.
  { re: /Adobe Photoshop(?: [A-Za-z0-9.]+){0,3}(?: \((?:Windows|Macintosh|Mac OS X?|iOS|Android)\))?/, label: 'Adobe Photoshop' },
  { re: /Photoshop/, label: 'Adobe Photoshop' },
  { re: /Adobe Lightroom|Lightroom/, label: 'Adobe Lightroom' },
  { re: /\bGIMP(?: [0-9.]+)?\b/, label: 'GIMP' },
  { re: /\bCanva\b/, label: 'Canva' },
  { re: /Pixelmator/, label: 'Pixelmator' },
  { re: /Affinity Photo/, label: 'Affinity Photo' },
  { re: /Paint\.NET/i, label: 'Paint.NET' },
  { re: /PicsArt/i, label: 'PicsArt' },
  { re: /Snapseed/, label: 'Snapseed' },
  { re: /Photopea/, label: 'Photopea' },
  { re: /Fotor\b/, label: 'Fotor' },
]

const AI_SIGNATURES = [
  { re: /trainedAlgorithmicMedia/, label: 'IPTC "trained algorithmic media" (generative AI) source type' },
  { re: /Adobe Firefly|Generative Fill/, label: 'Adobe Firefly / Generative Fill' },
  { re: /Midjourney/i, label: 'Midjourney' },
  { re: /DALL[·\-\s]?E/, label: 'DALL·E' },
  { re: /Stable Diffusion|parameters\0[^\0]{0,400}Steps: \d+/, label: 'Stable Diffusion' },
  { re: /ComfyUI/, label: 'ComfyUI' },
]

const EXIF_DATE = /\b((?:19|20)\d{2}):(0[1-9]|1[0-2]):(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g
const XMP_DATE = /(xmp:CreateDate|xmp:ModifyDate|exif:DateTimeOriginal|photoshop:DateCreated)(?:\s*=\s*"|>)((?:19|20)\d{2}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)/g

function parseExifDate(m) {
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Signals found in the raw bytes. Pure: no I/O. */
export function inspectMetadata(buffer) {
  const text = metadataText(buffer)
  const editors = [...new Set(EDITOR_SIGNATURES.filter((s) => s.re.test(text)).map((s) => s.label))]
  const editorDetail = EDITOR_SIGNATURES.map((s) => s.re.exec(text)?.[0]).find(Boolean) ?? null
  const aiMarkers = [...new Set(AI_SIGNATURES.filter((s) => s.re.test(text)).map((s) => s.label))]

  const captureDates = []
  for (const m of text.matchAll(EXIF_DATE)) {
    const d = parseExifDate(m)
    if (d) captureDates.push(d)
  }
  const xmp = {}
  for (const m of text.matchAll(XMP_DATE)) {
    const d = new Date(m[2])
    if (Number.isNaN(d.getTime())) continue
    xmp[m[1]] = d
    if (m[1] !== 'xmp:ModifyDate') captureDates.push(d)
  }
  const now = Date.now()
  const plausible = captureDates.filter((d) => d.getUTCFullYear() >= 1995 && d.getTime() <= now + DAY)
  const earliest = plausible.length ? new Date(Math.min(...plausible.map((d) => d.getTime()))) : null

  const created = xmp['xmp:CreateDate'] || xmp['exif:DateTimeOriginal']
  const modified = xmp['xmp:ModifyDate']
  const modifiedAfterCapture = Boolean(created && modified && modified - created > 60_000)
  const editHistory = /stEvt:action="(?:saved|converted|derived|edited)"|<stEvt:action>(?:saved|converted|derived|edited)</.test(text)

  return { editors, editorDetail: editorDetail?.replace(/[^\x20-\x7e]/g, '').trim() || null, aiMarkers, earliestCaptureDate: earliest, modifiedAfterCapture, created, modified, editHistory }
}

/** The bill date: a dated line first ("Bill date", "Invoice date", "Dated"), otherwise the first date on the page. */
function billDateFromText(text) {
  const lines = String(text).split('\n')
  const labelled = lines.find((l) => /\b(?:bill|invoice|receipt)\s*date\b|\bdated?\b/i.test(l) && parseIndianDate(l))
  if (labelled) return { value: parseIndianDate(labelled), evidence: labelled.trim().slice(0, 200) }
  const any = lines.find((l) => parseIndianDate(l))
  return any ? { value: parseIndianDate(any), evidence: any.trim().slice(0, 200) } : null
}

/** OCR the image and compare its total and date with the claim. */
export function inspectText(buffer, mimeType, claim) {
  if (!OCR_MIME_TYPES.includes(mimeType)) {
    return { read: false, amount: null, billDate: null, note: 'WebP cannot be decoded locally, so the printed text was not read. Metadata and duplicate checks still ran.', findings: [] }
  }
  if (buffer.length > OCR_MAX_BYTES) {
    return { read: false, amount: null, billDate: null, note: 'Image is too large to read locally; the printed text was not checked.', findings: [] }
  }
  const read = readFileText(buffer, mimeType)
  if (!read.hasTextLayer) {
    return { read: false, amount: null, billDate: null, note: 'No legible printed text was found (a photograph rather than a bill, or too blurry).', findings: [] }
  }
  const ocrConfidence = Math.min(1, Math.max(0, read.ocrConfidence ?? 0.6))
  const amount = extractAmount(read.text)
  const bill = billDateFromText(read.text)
  const findings = []

  const claimed = claim.estimated_loss == null ? null : Number(claim.estimated_loss)
  if (amount && claimed && claimed > 0) {
    const gap = Math.abs(amount.value - claimed) / claimed
    if (gap > AMOUNT_TOLERANCE) {
      findings.push({
        check: 'AMOUNT_MISMATCH',
        severity: gap >= 0.5 ? 'HIGH' : 'MEDIUM',
        confidence: round3(ocrConfidence * (amount.confident ? 0.8 : 0.55)),
        evidence: `OCR read a bill total of ${rupees(amount.value)} ("${amount.evidence}") but the claim states ${rupees(claimed)} — a ${Math.round(gap * 100)}% difference.`,
      })
    }
  }
  if (bill?.value && claim.loss_date && dayStart(bill.value) < dayStart(claim.loss_date)) {
    const days = Math.round((dayStart(claim.loss_date) - dayStart(bill.value)) / DAY)
    findings.push({
      check: 'BILL_DATE_BEFORE_LOSS',
      severity: days > 7 ? 'HIGH' : 'MEDIUM',
      confidence: round3(ocrConfidence * 0.7),
      evidence: `The bill is dated ${bill.value} ("${bill.evidence}"), ${days} day(s) before the date of loss ${isoDay(claim.loss_date)}.`,
    })
  }
  return { read: true, amount: amount?.value ?? null, billDate: bill?.value ?? null, note: null, findings }
}

/** Overall confidence: the chance that at least one independent signal is right. */
function combine(checks) {
  const miss = checks.reduce((p, c) => p * (1 - c.confidence), 1)
  return round3(Math.min(0.99, 1 - miss))
}

function riskLevelFor(checks) {
  if (checks.some((c) => c.severity === 'HIGH')) return 'HIGH'
  if (checks.filter((c) => c.severity === 'MEDIUM').length >= 2) return 'HIGH'
  if (checks.some((c) => c.severity === 'MEDIUM')) return 'MEDIUM'
  return 'LOW'
}

/**
 * Runs all three checks on one image. Pure apart from the duplicate list,
 * which the caller supplies. Returns `null` when nothing was found.
 */
export function scanImage({ buffer, document, claim, duplicates = [], now = new Date() }) {
  const sha = sha256Hex(buffer)
  const checks = []
  const lossDay = claim.loss_date ? dayStart(claim.loss_date) : null

  // Check 1 — the same bytes on another claim.
  if (duplicates.length && buffer.length >= MIN_DUPLICATE_BYTES) {
    const first = duplicates[0]
    checks.push({
      check: 'DUPLICATE_IMAGE',
      severity: 'HIGH',
      confidence: 0.97,
      evidence: `The identical file (SHA-256 ${sha.slice(0, 12)}…) is also filed on claim ${first.claimNumber || 'a draft claim'} as "${first.fileName}"${duplicates.length > 1 ? ` and on ${duplicates.length - 1} other claim(s)` : ''}.`,
      matchedClaimNumber: first.claimNumber ?? null,
    })
  }

  // Check 2 — editing software, generative AI, edit history, capture date.
  const meta = inspectMetadata(buffer)
  if (meta.aiMarkers.length) {
    checks.push({ check: 'AI_GENERATED', severity: 'HIGH', confidence: 0.9, evidence: `The file carries a generative-AI marker: ${meta.aiMarkers.join(', ')}.`, matchedClaimNumber: null })
  }
  if (meta.editors.length) {
    checks.push({
      check: 'EDITING_SOFTWARE',
      severity: 'HIGH',
      confidence: 0.85,
      evidence: `The file's metadata names editing software: ${meta.editorDetail && meta.editors.length === 1 ? `"${meta.editorDetail}"` : meta.editors.join(', ')}. A camera or scanner original does not carry this.`,
      matchedClaimNumber: null,
    })
  }
  if (meta.modifiedAfterCapture || meta.editHistory) {
    checks.push({
      check: 'MODIFIED_AFTER_CAPTURE',
      severity: 'MEDIUM',
      confidence: 0.6,
      evidence: meta.modifiedAfterCapture
        ? `XMP records the image as modified on ${meta.modified.toISOString().slice(0, 16).replace('T', ' ')}, after it was created on ${meta.created.toISOString().slice(0, 16).replace('T', ' ')}.`
        : 'XMP edit history records the image as saved or converted after capture.',
      matchedClaimNumber: null,
    })
  }
  if (meta.earliestCaptureDate && lossDay != null && dayStart(meta.earliestCaptureDate) < lossDay) {
    const days = Math.round((lossDay - dayStart(meta.earliestCaptureDate)) / DAY)
    checks.push({
      check: 'CAPTURED_BEFORE_LOSS',
      severity: days > 3 ? 'HIGH' : 'MEDIUM',
      confidence: 0.75,
      evidence: `Embedded capture date ${meta.earliestCaptureDate.toISOString().slice(0, 10)} is ${days} day(s) before the date of loss ${isoDay(claim.loss_date)}.`,
      matchedClaimNumber: null,
    })
  }

  // Check 3 — OCR total and date against the claim.
  const ocr = inspectText(buffer, document.mime_type, claim)
  for (const f of ocr.findings) checks.push({ ...f, matchedClaimNumber: null })

  if (!checks.length) return null
  const withCodes = checks.map((c) => ({ ...c, code: CHECK_REASON_CODES[c.check][0] }))
  return imageFraudAlertSchema.parse({
    documentId: document.id,
    fileName: document.file_name,
    docType: document.doc_type ?? null,
    mimeType: document.mime_type,
    sha256: sha,
    riskLevel: riskLevelFor(withCodes),
    confidence: combine(withCodes),
    matchedClaimNumber: checks.some((c) => c.check === 'DUPLICATE_IMAGE') ? duplicates[0]?.claimNumber ?? null : null,
    matchedClaims: checks.some((c) => c.check === 'DUPLICATE_IMAGE') ? duplicates.slice(0, 10) : [],
    evidence: withCodes.map((c) => c.evidence),
    checks: withCodes,
    ocr: { read: ocr.read, amount: ocr.amount, billDate: ocr.billDate, note: ocr.note },
    engine: IMAGE_FORENSICS_ENGINE,
    scannedAt: now.toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Database-backed scanning
// ---------------------------------------------------------------------------
/** Other claims holding the exact same bytes (document_files + documents + claims, by SHA-256). */
export async function findDuplicateImages(db, sha, claimId) {
  const rows = await db.query(
    `select distinct on (c.id) c.claim_number, d.id as document_id, d.file_name
       from public.document_files f
       join public.documents d on d.storage_key = f.storage_key
       join public.claims c on c.id = d.claim_id
      where f.sha256 = $1 and d.claim_id <> $2
      order by c.id, f.created_at
      limit 10`,
    [sha, claimId],
  )
  return rows.map((r) => ({ claimNumber: r.claim_number ?? null, documentId: r.document_id, fileName: r.file_name }))
}

async function loadImageRows(db, claimId, documentId) {
  return db.query(
    `select d.id, d.claim_id, d.doc_type, d.file_name, d.mime_type, d.status, f.content
       from public.documents d
       join public.document_files f on f.storage_key = d.storage_key
      where d.claim_id = $1
        and d.mime_type = any($2)
        and coalesce(d.status, '') <> 'SUPERSEDED'
        ${documentId ? 'and d.id = $4' : ''}
      order by d.received_at desc nulls last
      limit $3`,
    documentId ? [claimId, IMAGE_MIME_TYPES, MAX_IMAGES_PER_CLAIM, documentId] : [claimId, IMAGE_MIME_TYPES, MAX_IMAGES_PER_CLAIM],
  )
}

/**
 * Scans the image documents on a claim (or just `documentId`).
 * Never throws for a single bad file: an image that cannot be inspected is
 * skipped, so one corrupt upload cannot block a triage run.
 */
export async function scanClaimImages(db, claim, { documentId = null, now = new Date() } = {}) {
  const rows = await loadImageRows(db, claim.id, documentId)
  const alerts = []
  for (const row of rows) {
    try {
      const buffer = Buffer.from(row.content)
      const duplicates = buffer.length >= MIN_DUPLICATE_BYTES ? await findDuplicateImages(db, sha256Hex(buffer), claim.id) : []
      const alert = scanImage({ buffer, document: row, claim, duplicates, now })
      if (alert) alerts.push(alert)
    } catch {
      // A malformed file yields no alert rather than failing the whole scan.
    }
  }
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 }
  return alerts.sort((a, b) => order[a.riskLevel] - order[b.riskLevel] || b.confidence - a.confidence)
}

/** One-line headline for notes and audit metadata. */
export function describeAlerts(alerts) {
  if (!alerts?.length) return null
  const high = alerts.filter((a) => a.riskLevel === 'HIGH').length
  return `Beacon image forensics: ${alerts.length} image(s) with fraud indicators${high ? `, ${high} high risk` : ''}. Review before relying on these documents.`
}
