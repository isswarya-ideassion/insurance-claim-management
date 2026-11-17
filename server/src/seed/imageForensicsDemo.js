import { randomUUID, createHash } from 'node:crypto'
import { renderText, rasterToGray } from '../services/intelligence/vision/ocr.js'
import { encodeGrayPng } from '../services/intelligence/vision/imageCodec.js'
import { DEMO_DOMAIN } from './demoData.js'

/**
 * FICTIONAL DEMO DATA for the Beacon AI Image Forensics walkthrough.
 *
 * Adds one photographed hospital bill that trips all three local checks:
 *   1. the identical file is on two claims (HPC-2026-000104 and -000110);
 *   2. its PNG metadata names "Adobe Photoshop" and carries a capture date a
 *      month before the loss;
 *   3. the OCR-readable total (Rs 48,500.00) differs from both claims' amounts
 *      and the printed bill date is before the loss.
 *
 * Idempotent and separate from seedDemoData so a demo database seeded before
 * this existed gets the image on the next start (SEED_DEMO_DATA=true) or
 * `npm run db:seed-demo`.
 */

const TARGET = 'HPC-2026-000104' // Document review, health — Raj (Document Reviewer) reviews it
const PARTNER = 'HPC-2026-000110' // Compliance review, travel — Adjuster Amara's claim
const FILE_NAME = 'hospital-bill-photo.png'
const PARTNER_FILE_NAME = 'replacement-receipt-photo.png'
const DAY = 86_400_000

const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
const exifDate = (d) => d.toISOString().slice(0, 19).replace(/-/g, ':').replace('T', ' ')

/** A forged bill: legible to our OCR, with editor metadata in its PNG tEXt chunks. */
export function buildForgedBillPng(lossDate) {
  const billDate = new Date(new Date(lossDate).getTime() - 20 * DAY)
  const captured = new Date(new Date(lossDate).getTime() - 30 * DAY)
  const { binary, width, height } = renderText(
    [
      'CITY CARE HOSPITAL KOCHI',
      'SAMPLE DEMO BILL - FICTIONAL',
      'TAX INVOICE NO 44073',
      `BILL DATE ${ddmmyyyy(billDate)}`,
      'ROOM CHARGES 12,000.00',
      'PHARMACY 8,500.00',
      'SURGEON FEES 28,000.00',
      'GRAND TOTAL RS 48,500.00',
    ],
    { scale: 4, padding: 32 },
  )
  const { gray } = rasterToGray(binary, width, height)
  return encodeGrayPng(width, height, gray, {
    text: {
      Software: 'Adobe Photoshop 25.4 (Windows)',
      'Creation Time': exifDate(captured),
      Comment: 'Fictional demo image for Beacon AI Image Forensics',
    },
  })
}

async function addImageDoc(t, storage, { claim, buffer, fileName, docType, status, reviewerId, daysAgo }) {
  const id = randomUUID()
  const storageKey = `claims/${claim.id}/${id}.png`
  const sha = createHash('sha256').update(buffer).digest('hex')
  const receivedAt = new Date(Date.now() - daysAgo * DAY)
  const reviewed = status === 'ACCEPTED'
  await storage.put(storageKey, buffer, 'image/png', t)
  const doc = await t.insert('documents', {
    id,
    claim_id: claim.id,
    version: 1,
    doc_type: docType,
    file_name: fileName,
    storage_key: storageKey,
    mime_type: 'image/png',
    size_bytes: buffer.length,
    sha256: sha,
    source: 'WEB',
    status,
    uploaded_by: claim.customer_id,
    received_at: receivedAt,
    reviewer_id: reviewerId,
    review_assigned_at: reviewerId ? receivedAt : null,
    reviewed_by: reviewed ? reviewerId : null,
    reviewed_at: reviewed ? new Date(receivedAt.getTime() + DAY) : null,
    review_comment: reviewed ? 'Legible and complete.' : null,
  })
  await t.insert('document_versions', {
    document_id: id,
    version_no: 1,
    storage_key: storageKey,
    file_name: fileName,
    mime_type: 'image/png',
    size_bytes: buffer.length,
    sha256: sha,
    status,
    uploaded_by: doc.uploaded_by,
    uploaded_at: doc.received_at,
    reviewed_by: doc.reviewed_by,
    reviewed_at: doc.reviewed_at,
  })
  return doc
}

export async function ensureImageForensicsDemo({ db, storage, log = () => {} }) {
  const claims = await db.findMany('claims', { where: { claim_number: { in: [TARGET, PARTNER] } } })
  const target = claims.find((c) => c.claim_number === TARGET)
  const partner = claims.find((c) => c.claim_number === PARTNER)
  if (!target || !partner) return false
  if (await db.findOne('documents', { claim_id: target.id, file_name: FILE_NAME })) return false

  const [raj] = await db.query('select id from public.users where email = $1', [`reviewer.raj@${DEMO_DOMAIN}`])
  const png = buildForgedBillPng(target.loss_date)

  await db.tx(async (t) => {
    await t.query(`select set_config('app.seed_mode', 'on', true)`)
    // Pending review on the Document Review claim, so it is in Raj's queue.
    await addImageDoc(t, storage, { claim: target, buffer: png, fileName: FILE_NAME, docType: 'INVOICE', status: 'PENDING_REVIEW', reviewerId: raj?.id ?? null, daysAgo: 1 })
    // The same bytes, filed earlier on another claimant's claim.
    await addImageDoc(t, storage, { claim: partner, buffer: png, fileName: PARTNER_FILE_NAME, docType: 'INVOICE', status: 'ACCEPTED', reviewerId: raj?.id ?? null, daysAgo: 10 })
  })
  log(`image forensics demo ready: ${FILE_NAME} on ${TARGET} (duplicate on ${PARTNER})`)
  return true
}
