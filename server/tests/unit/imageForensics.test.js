import { describe, expect, it } from 'vitest'
import { createAiProvider } from '../../src/services/ai.service.js'
import {
  CHECK_REASON_CODES,
  inspectMetadata,
  imageFraudAlertSchema,
  scanImage,
} from '../../src/services/intelligence/imageForensics.service.js'
import { encodeGrayPng } from '../../src/services/intelligence/vision/imageCodec.js'
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

  it('does not treat the bare letters "AI" in binary data as a generative-AI marker', () => {
    expect(inspectMetadata(Buffer.from('\x00AI\x00Modified\x00', 'latin1')).aiMarkers).toEqual([])
  })

  it('maps every check to a reason code', () => {
    for (const codes of Object.values(CHECK_REASON_CODES)) expect(codes.length).toBeGreaterThan(0)
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
