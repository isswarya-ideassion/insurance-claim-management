import { describe, expect, it } from 'vitest'
import { createAiProvider } from '../../src/services/ai.service.js'
import {
  CHECK_REASON_CODES,
  fraudChecksOf,
  inspectMetadata,
  imageFraudAlertSchema,
  isFraudAlert,
  scanImage,
} from '../../src/services/intelligence/imageForensics.service.js'
import { IRRELEVANT_EVIDENCE, assessRelevance, relevanceSignals } from '../../src/services/intelligence/documentRelevance.js'
import { readFileText } from '../../src/services/intelligence/documentIntelligence.service.js'
import { encodeGrayPng } from '../../src/services/intelligence/vision/imageCodec.js'
import { renderText, rasterToGray } from '../../src/services/intelligence/vision/ocr.js'
import { buildForgedBillPng } from '../../src/seed/imageForensicsDemo.js'
import { AI_AGENTS } from '../../../shared/constants.js'

const DAY = 86_400_000
const lossDate = new Date(Date.now() - 5 * DAY)
const claim = { id: 'c1', loss_date: lossDate, estimated_loss: '9600.00' }
const doc = (over = {}) => ({ id: '11111111-1111-4111-8111-111111111111', file_name: 'bill.png', doc_type: 'INVOICE', mime_type: 'image/png', ...over })
const checksOf = (alert) => alert.checks.map((c) => c.check).sort()

describe('Beacon image forensics', () => {
  const forged = buildForgedBillPng(lossDate)

  it('flags the seeded demo bill on all three checks', () => {
    const alert = scanImage({
      buffer: forged,
      document: doc(),
      claim,
      duplicates: [{ claimNumber: 'HPC-2026-000110', documentId: '22222222-2222-4222-8222-222222222222', fileName: 'receipt.png' }],
    })
    expect(imageFraudAlertSchema.safeParse(alert).success).toBe(true)
    expect(alert.riskLevel).toBe('HIGH')
    expect(alert.matchedClaimNumber).toBe('HPC-2026-000110')
    expect(checksOf(alert)).toEqual(['AMOUNT_MISMATCH', 'BILL_DATE_BEFORE_LOSS', 'CAPTURED_BEFORE_LOSS', 'DUPLICATE_IMAGE', 'EDITING_SOFTWARE'])
    expect(alert.ocr).toMatchObject({ read: true, amount: 48500 })
    expect(alert.evidence.join(' ')).toContain('Adobe Photoshop 25.4 (Windows)')
  })

  it('ignores tiny placeholder files shared across claims', () => {
    const placeholder = encodeGrayPng(4, 4, new Uint8ClampedArray(16).fill(255))
    const dup = [{ claimNumber: 'HPC-2026-000001', documentId: '22222222-2222-4222-8222-222222222222', fileName: 'photos.jpg' }]
    expect(scanImage({ buffer: placeholder, document: doc(), claim, duplicates: dup })).toBeNull()
  })

  it('returns nothing for a plain image with no indicators', () => {
    const plain = encodeGrayPng(40, 40, new Uint8ClampedArray(1600).fill(200))
    expect(scanImage({ buffer: plain, document: doc(), claim })).toBeNull()
  })

  it('does not flag a bill whose total matches the claim and is dated after the loss', () => {
    const matching = { ...claim, estimated_loss: 48500, loss_date: new Date(Date.now() - 60 * DAY) }
    const alert = scanImage({ buffer: forged, document: doc(), claim: matching })
    // Editing software is still present; the OCR checks are not.
    expect(checksOf(alert)).toEqual(['EDITING_SOFTWARE'])
  })

  it('still runs the metadata checks on WebP, which cannot be decoded locally', () => {
    const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8X', 'latin1'), Buffer.from('<x:xmpmeta>Canva</x:xmpmeta>', 'latin1')])
    const alert = scanImage({ buffer: webp, document: doc({ mime_type: 'image/webp' }), claim })
    expect(checksOf(alert)).toEqual(['EDITING_SOFTWARE'])
    expect(alert.ocr.read).toBe(false)
  })

  it('reads XMP edit dates and generative-AI markers', () => {
    const xmp = Buffer.from(
      '<x:xmpmeta xmp:CreateDate="2026-01-02T10:00:00Z" xmp:ModifyDate="2026-01-05T10:00:00Z" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>',
      'latin1',
    )
    const meta = inspectMetadata(xmp)
    expect(meta.modifiedAfterCapture).toBe(true)
    expect(meta.aiMarkers.length).toBe(1)
  })

  it('reads a capture date whatever byte follows it (a PNG chunk CRC sits right after)', () => {
    for (let b = 0; b < 256; b++) {
      if (b >= 0x30 && b <= 0x39) continue // a following digit would make it a different number
      const buf = Buffer.concat([Buffer.from('Creation Time\x002026:10:01 10:00:00', 'latin1'), Buffer.from([b, 1, 2, 3])])
      expect(inspectMetadata(buf).earliestCaptureDate, `byte ${b}`).not.toBeNull()
    }
  })

  it('does not treat the bare letters "AI" in binary data as a generative-AI marker', () => {
    expect(inspectMetadata(Buffer.from('\x00AI\x00Modified\x00', 'latin1')).aiMarkers).toEqual([])
  })

  it('maps every check to a reason code', () => {
    for (const codes of Object.values(CHECK_REASON_CODES)) expect(codes.length).toBeGreaterThan(0)
  })
})

describe('Beacon claim-relevance check', () => {
  const textPng = (lines) => {
    const { binary, width, height } = renderText(lines, { scale: 4, padding: 32 })
    return encodeGrayPng(width, height, rasterToGray(binary, width, height).gray)
  }
  const unrelated = textPng(['HAPPY BIRTHDAY PRIYA', 'SEE YOU AT THE PARTY', 'LOTS OF LOVE FROM ALL OF US', 'WE WILL MEET AT THE BEACH', 'BRING YOUR GUITAR AND SNACKS', 'HAVE A WONDERFUL YEAR AHEAD'])

  it('uses a fixture large enough for the duplicate check to apply', () => {
    expect(unrelated.length).toBeGreaterThanOrEqual(2048)
  })
  const dup = [{ claimNumber: 'HPC-2026-000110', documentId: '22222222-2222-4222-8222-222222222222', fileName: 'wallpaper.png' }]

  it('marks readable text with nothing about a claim as an unnecessary document, not a duplicate fraud alert', () => {
    const alert = scanImage({ buffer: unrelated, document: doc({ doc_type: 'PROOF_OF_LOSS' }), claim, duplicates: dup })
    expect(alert.relevance).toBe('IRRELEVANT')
    expect(alert.checks.map((c) => c.check)).toEqual(['IRRELEVANT_DOCUMENT'])
    expect(alert.checks[0]).toMatchObject({ severity: 'MEDIUM', title: 'Unnecessary / Unrelated Document', evidence: IRRELEVANT_EVIDENCE })
    expect(alert.matchedClaimNumber).toBeNull()
    expect(isFraudAlert(alert)).toBe(false)
    expect(fraudChecksOf(alert)).toEqual([])
  })

  it('keeps the seeded forged bill relevant (bill, total, Rs, a date)', () => {
    const alert = scanImage({ buffer: buildForgedBillPng(lossDate), document: doc(), claim, duplicates: dup })
    expect(alert.relevance).toBe('RELEVANT')
    expect(alert.checks.map((c) => c.check)).toContain('DUPLICATE_IMAGE')
  })

  it('does not judge photos: a damage photo with no text still gets the duplicate check', () => {
    const alert = scanImage({ buffer: unrelated, document: doc({ doc_type: 'PHOTOS' }), claim, duplicates: dup })
    expect(alert.relevance).toBe('UNKNOWN')
    expect(alert.checks.map((c) => c.check)).toEqual(['DUPLICATE_IMAGE'])
  })

  it('counts the insured name, policy number or loss location as claim evidence', () => {
    const named = { ...claim, insured_name: 'Priya Raman' }
    expect(relevanceSignals('HAPPY BIRTHDAY PRIYA', { claim: named })).toContain('insured name')
    expect(relevanceSignals('ref HP-MOT-778812 attached', { policy: { external_policy_no: 'HP-MOT-778812' } })).toContain('policy number')
    expect(relevanceSignals('SEEN NEAR KAKKANAD', { claim: { loss_location: 'Kakkanad, Kochi' } })).toContain('loss location')
    expect(relevanceSignals('LOTS OF LOVE')).toEqual([])
  })

  it('treats a file it cannot open as unknown, not irrelevant', () => {
    expect(assessRelevance({ read: { text: '', hasTextLayer: false, reason: 'IMAGE_DECODE_FAILED' }, docType: 'INVOICE' }).status).toBe('UNKNOWN')
    expect(assessRelevance({ read: { text: '', hasTextLayer: false, reason: 'PDF_PARSE_FAILED' }, docType: 'INVOICE' }).status).toBe('UNKNOWN')
  })

  it('never throws on malformed or arbitrary bytes', () => {
    const junk = [
      Buffer.alloc(0),
      Buffer.from('\x89PNG\r\n\x1a\nnot really a png at all, just bytes'.repeat(100), 'latin1'),
      Buffer.from([0xff, 0xd8, 0xff, ...Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)]),
      Buffer.from('RIFF\0\0\0\0WEBPjunk'.repeat(200), 'latin1'),
    ]
    for (const buffer of junk) {
      for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
        expect(() => scanImage({ buffer, document: doc({ mime_type: mime, doc_type: 'INVOICE' }), claim, duplicates: dup })).not.toThrow()
      }
    }
    expect(readFileText(Buffer.from('%PDF-1.4 garbage with no objects'), 'application/pdf').hasTextLayer).toBe(false)
  })

  it('reads stored alerts from before the relevance check as fraud alerts', () => {
    const old = { ...scanImage({ buffer: buildForgedBillPng(lossDate), document: doc(), claim }) }
    delete old.relevance
    const parsed = imageFraudAlertSchema.parse(old)
    expect(parsed.relevance).toBe('RELEVANT')
    expect(isFraudAlert(parsed)).toBe(true)
  })
})

describe('Beacon triage with image forensics', () => {
  const beacon = createAiProvider({ AI_PROVIDER: 'beacon' })
  const taxonomy = ['DUPLICATE_DOCUMENT_IMAGE', 'DOCUMENT_TAMPERING', 'INCONSISTENT_STATEMENTS'].map((code) => ({ code, weight: 40 }))

  it('adds image indicators to the reasons and the score', async () => {
    const base = { loss: { estimated_loss: 9600, claim_type: 'HEALTH' }, fraud_reason_taxonomy: taxonomy, prior_claims_on_policy_24_months: ['CLOSED'] }
    const clean = (await beacon.generateJson({ agent: AI_AGENTS.TRIAGE_ROUTER, input: base })).data
    const flagged = (
      await beacon.generateJson({
        agent: AI_AGENTS.TRIAGE_ROUTER,
        input: {
          ...base,
          image_forensics: [
            {
              risk_level: 'HIGH',
              checks: [
                { check: 'DUPLICATE_IMAGE', code: 'DUPLICATE_DOCUMENT_IMAGE', severity: 'HIGH' },
                { check: 'EDITING_SOFTWARE', code: 'DOCUMENT_TAMPERING', severity: 'HIGH' },
              ],
            },
          ],
        },
      })
    ).data
    expect(flagged.fraud_reasons.map((r) => r.code).sort()).toEqual(['DOCUMENT_TAMPERING', 'DUPLICATE_DOCUMENT_IMAGE'])
    expect(flagged.fraud_score).toBeGreaterThan(clean.fraud_score)
  })
})
