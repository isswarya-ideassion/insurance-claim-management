import { EXTRACTABLE_CLAIM_FIELDS } from '../../../../shared/constants.js'
import { classify, crossValidate, trainNaiveBayes } from './naiveBayes.js'
import { extractIndianFields, maskAadhaar } from './indianFields.js'
import { extractPdfText } from './pdfText.js'
import { decodeImage } from './vision/imageCodec.js'
import { assessQuality, prepareDocument } from './vision/preprocess.js'
import { recognize } from './vision/ocr.js'

/**
 * Document intelligence for the Document Reviewer queue.
 *
 * Produces two things for a document, both as PROPOSALS a reviewer confirms:
 *   1. a suggested doc_type, from a classifier trained on our own labels;
 *   2. extracted fields, from the statutory formats Indian paperwork uses.
 *
 * Nothing here writes to a claim. EXTRACTABLE_CLAIM_FIELDS is explicit that
 * every value needs human confirmation before it is saved, and that contract
 * is unchanged — this only removes the typing, not the checking.
 */

export const CLASSIFIER_NAME = 'document-classifier'

/** Below this a suggestion is shown as a hint, not a pre-filled answer. */
export const CONFIDENT_ENOUGH = 0.65
/** Fewer labelled documents than this and cross-validation is meaningless. */
export const MIN_TRAINING_DOCS = 30
/** Below this mean glyph-match margin, OCR output is not treated as text. */
export const OCR_MIN_CONFIDENCE = 0.4

const EXTRACTABLE_KEYS = new Set(EXTRACTABLE_CLAIM_FIELDS.map((f) => f.key))

/** What to tell a person when a file cannot be read automatically, by `reason`. */
export function unreadableMessage(reason, quality) {
  const MESSAGES = {
    IMAGE_UNREADABLE: `This photograph cannot be read: ${(quality?.issues ?? []).join(', ').toLowerCase() || 'quality too poor'}. Ask for a clearer picture.`,
    OCR_LOW_CONFIDENCE: 'The text in this image does not match any trained typeface closely enough to read. Review it by eye.',
    IMAGE_DECODE_FAILED: 'This image could not be decoded. Ask for it as a PNG or JPEG.',
    SCANNED_NEEDS_OCR: 'This PDF is a scan with no text layer. Review it by eye.',
  }
  return MESSAGES[reason] ?? 'This document could not be read automatically. Review it by eye.'
}

/**
 * Reads the text out of a file's bytes: the text layer of a PDF, or our own
 * OCR for an image. Synchronous and dependency-free, so it serves both the
 * reviewer screen and the Beacon extraction rule.
 */
export function readFileText(buffer, mimeType) {
  if (mimeType !== 'application/pdf') {
    // Images go through our own vision pipeline: decode, assess readability,
    // straighten, then recognise. A photograph too blurry or too dark to read
    // is reported as such rather than run through OCR to produce confident
    // nonsense.
    try {
      const image = decodeImage(buffer)
      const quality = assessQuality(image.gray, image.width, image.height)
      if (!quality.readable) return { text: '', hasTextLayer: false, reason: 'IMAGE_UNREADABLE', quality }
      const prepared = prepareDocument(image.gray, image.width, image.height)
      const ocr = recognize(prepared.binary, prepared.width, prepared.height)
      return {
        text: maskAadhaar(ocr.text),
        // Below this, the glyphs do not resemble the trained templates closely
        // enough to treat the output as text — most often an unfamiliar
        // typeface or handwriting.
        hasTextLayer: ocr.meanConfidence >= OCR_MIN_CONFIDENCE && ocr.text.length >= 16,
        source: 'OCR',
        ocrConfidence: ocr.meanConfidence,
        quality,
        reason: ocr.meanConfidence < OCR_MIN_CONFIDENCE ? 'OCR_LOW_CONFIDENCE' : null,
      }
    } catch (err) {
      return { text: '', hasTextLayer: false, reason: 'IMAGE_DECODE_FAILED', error: err.message }
    }
  }
  const { text, hasTextLayer, pages } = extractPdfText(buffer)
  return {
    // Masked before it is returned or stored: an Aadhaar in a document must
    // not spread into logs, proposals or the UI.
    text: maskAadhaar(text),
    hasTextLayer,
    pages,
    source: 'PDF_TEXT',
    reason: hasTextLayer ? null : 'SCANNED_NEEDS_OCR',
  }
}

/** Reads a stored document and returns its text layer. */
export async function documentText(db, documentId) {
  const [row] = await db.query(
    `select d.id, d.doc_type, d.mime_type, d.file_name, f.content
       from public.documents d
       join public.document_files f on f.storage_key = d.storage_key
      where d.id = $1`,
    [documentId],
  )
  if (!row) return null
  return { id: row.id, docType: row.doc_type, fileName: row.file_name, ...readFileText(Buffer.from(row.content), row.mime_type) }
}

async function labelledCorpus(db) {
  const rows = await db.query(
    `select d.id, d.doc_type, d.mime_type, f.content
       from public.documents d
       join public.document_files f on f.storage_key = d.storage_key
      where d.doc_type is not null and d.mime_type = 'application/pdf'`,
  )
  const samples = []
  let withoutText = 0
  for (const r of rows) {
    const { text, hasTextLayer } = extractPdfText(Buffer.from(r.content))
    if (!hasTextLayer) {
      withoutText += 1
      continue
    }
    samples.push({ label: r.doc_type, text: maskAadhaar(text) })
  }
  return { samples, withoutText, total: rows.length }
}

/**
 * Trains the classifier and stores it in ml_models beside the anomaly model.
 * The measured cross-validation accuracy is stored with it, so the UI can
 * tell a reviewer how much the suggestion is worth.
 */
export async function trainDocumentClassifier(db, { actorId = null } = {}) {
  const { samples, withoutText, total } = await labelledCorpus(db)
  if (samples.length < MIN_TRAINING_DOCS) {
    const err = new Error(
      `Need at least ${MIN_TRAINING_DOCS} labelled PDFs with a text layer to train; found ${samples.length} ` +
        `(${withoutText} of ${total} had no text layer and need OCR).`,
    )
    err.code = 'INSUFFICIENT_TRAINING_DATA'
    err.samples = samples.length
    err.withoutText = withoutText
    throw err
  }

  const model = trainNaiveBayes(samples)
  const evaluation = crossValidate(samples)

  return db.tx(async (t) => {
    const [{ next }] = await t.query(
      'select coalesce(max(version), 0) + 1 as next from public.ml_models where name = $1',
      [CLASSIFIER_NAME],
    )
    await t.query('update public.ml_models set active = false where name = $1 and active', [CLASSIFIER_NAME])
    const [saved] = await t.query(
      `insert into public.ml_models (name, version, algorithm, payload, feature_names, trained_on, metrics, trained_by, active)
       values ($1, $2, 'naive-bayes', $3, $4, $5, $6, $7, true)
       returning id, version, trained_on, metrics`,
      [
        CLASSIFIER_NAME,
        next,
        JSON.stringify(model),
        model.classes,
        samples.length,
        JSON.stringify({ ...evaluation, classes: model.classes.length, vocabulary: model.vocabSize, withoutTextLayer: withoutText }),
        actorId,
      ],
    )
    return saved
  })
}

async function loadClassifier(db) {
  const [row] = await db.query(
    'select id, version, payload, metrics from public.ml_models where name = $1 and active',
    [CLASSIFIER_NAME],
  )
  if (!row) return null
  return {
    id: row.id,
    version: row.version,
    metrics: row.metrics,
    model: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }
}

/**
 * Everything the reviewer screen needs for one document.
 * Returns `null` for a document that does not exist; otherwise always returns
 * a result, with `needsOcr` set when there is no text to work from.
 */
export async function analyseDocument(db, documentId) {
  const doc = await documentText(db, documentId)
  if (!doc) return null

  if (!doc.hasTextLayer) {
    return {
      documentId: doc.id,
      fileName: doc.fileName,
      needsOcr: true,
      reason: doc.reason,
      message: unreadableMessage(doc.reason, doc.quality),
      quality: doc.quality ?? null,
      suggestedType: null,
      identifiers: [],
      proposals: [],
    }
  }

  const classifier = await loadClassifier(db)
  const prediction = classifier ? classify(classifier.model, doc.text) : { label: null, confidence: 0, scores: [] }
  const { identifiers, fields, aadhaarPresent } = extractIndianFields(doc.text)

  // Shaped to mirror EXTRACTABLE_CLAIM_FIELDS so the reviewer screen can show
  // proposals beside the claim values they would replace.
  const proposals = []
  for (const [key, raw] of Object.entries(fields)) {
    if (!EXTRACTABLE_KEYS.has(key)) continue
    const value = typeof raw === 'object' ? raw.value : raw
    proposals.push({
      key,
      label: EXTRACTABLE_CLAIM_FIELDS.find((f) => f.key === key)?.label ?? key,
      value,
      evidence: typeof raw === 'object' ? raw.evidence : null,
      confident: typeof raw === 'object' ? raw.confident : true,
      // Unchanged contract: nothing is written without a person saying so.
      needsConfirmation: true,
    })
  }

  return {
    documentId: doc.id,
    fileName: doc.fileName,
    needsOcr: false,
    pages: doc.pages,
    currentType: doc.docType,
    suggestedType: prediction.label,
    typeConfidence: prediction.confidence,
    // Below the threshold the suggestion is a hint, never a pre-selection.
    typeIsSuggestionOnly: prediction.confidence < CONFIDENT_ENOUGH,
    classifierVersion: classifier?.version ?? null,
    classifierAccuracy: classifier?.metrics?.accuracy ?? null,
    alternatives: prediction.scores.slice(0, 3),
    identifiers,
    aadhaarPresent,
    proposals,
    unmatchedFields: Object.keys(fields).filter((k) => !EXTRACTABLE_KEYS.has(k)).map((k) => ({ key: k, value: fields[k] })),
  }
}
