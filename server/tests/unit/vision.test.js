import { describe, expect, it } from 'vitest'
import { decodeImage, encodeGrayPng, isJpeg, isPng } from '../../src/services/intelligence/vision/imageCodec.js'
import { assessQuality, binarize, deskew, estimateSkew, otsuThreshold, prepareDocument } from '../../src/services/intelligence/vision/preprocess.js'
import { connectedComponents, groupIntoLines, rasterToGray, recognize, renderText } from '../../src/services/intelligence/vision/ocr.js'

/** Rotates a grayscale raster, to build a deliberately skewed test page. */
function rotateGray(gray, width, height, degrees, background = 236) {
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = width / 2
  const cy = height / 2
  const out = new Uint8ClampedArray(width * height).fill(background)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + dx * cos + dy * sin)
      const sy = Math.round(cy - dx * sin + dy * cos)
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) out[y * width + x] = gray[sy * width + sx]
    }
  }
  return out
}

/**
 * Applies a brightness gradient — the shadow a phone casts over a page.
 *
 * `strength` 0.9 is a hard shadow: paper on the dark side ends up darker than
 * ink on the lit side, so the two classes overlap in brightness. That overlap
 * is precisely what a single global threshold cannot resolve, and it is common
 * in handheld photos of documents.
 */
function addShadow(gray, width, height, strength = 0.9) {
  const out = new Uint8ClampedArray(gray.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const falloff = 1 - strength * (x / width)
      out[y * width + x] = Math.round(gray[y * width + x] * falloff)
    }
  }
  return out
}

/**
 * Character accuracy by edit distance — the standard OCR measure.
 *
 * Position-by-position comparison is the wrong metric here: a single spurious
 * blob inserts one character and misaligns everything after it, reporting ~50%
 * for output that is one character wrong. Levenshtein charges that insertion
 * once, which is what a reviewer would actually experience.
 */
function characterAccuracy(expected, actual) {
  const want = expected.join('').replace(/\s/g, '')
  const got = actual.replace(/[\s\n]/g, '')
  const prev = new Array(got.length + 1)
  const curr = new Array(got.length + 1)
  for (let j = 0; j <= got.length; j += 1) prev[j] = j
  for (let i = 1; i <= want.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= got.length; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (want[i - 1] === got[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= got.length; j += 1) prev[j] = curr[j]
  }
  return Math.max(0, 1 - prev[got.length] / want.length)
}

/** Global-threshold binarisation, as the naive alternative to Sauvola. */
function globalBinarize(gray, width, height) {
  const threshold = otsuThreshold(gray)
  const out = new Uint8Array(width * height)
  for (let i = 0; i < gray.length; i += 1) out[i] = gray[i] <= threshold ? 1 : 0
  return out
}

describe('image codec', () => {
  it('round-trips a grayscale PNG through encode and decode', () => {
    const width = 64
    const height = 40
    const gray = new Uint8ClampedArray(width * height)
    for (let i = 0; i < gray.length; i += 1) gray[i] = (i * 7) % 256

    const png = encodeGrayPng(width, height, gray)
    expect(isPng(png)).toBe(true)

    const decoded = decodeImage(png)
    expect(decoded.width).toBe(width)
    expect(decoded.height).toBe(height)
    for (let i = 0; i < gray.length; i += 1) expect(decoded.gray[i]).toBe(gray[i])
  })

  it('identifies formats and refuses what it cannot decode', () => {
    expect(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true)
    expect(isPng(Buffer.from('not an image'))).toBe(false)
    expect(() => decodeImage(Buffer.from('not an image'))).toThrow(/Unrecognised image format/)
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    expect(() => decodeImage(webp)).toThrow(/WebP is not supported/)
  })
})

describe('preprocessing', () => {
  it('separates ink from paper with Otsu', () => {
    const gray = new Uint8ClampedArray(100)
    gray.fill(30, 0, 40) // ink
    gray.fill(220, 40) // paper
    const threshold = otsuThreshold(gray)
    expect(threshold).toBeGreaterThan(30)
    expect(threshold).toBeLessThan(220)
  })

  it('reads through a hard shadow, where a global threshold cannot', () => {
    const source = ['INVOICE TOTAL 44073', 'POLICY HP MOT 889211']
    const { binary, width, height } = renderText(source, { scale: 4 })
    const { gray } = rasterToGray(binary, width, height)
    const shadowed = addShadow(gray, width, height)

    const adaptive = recognize(binarize(shadowed, width, height), width, height)
    const global = recognize(globalBinarize(shadowed, width, height), width, height)

    // The claim being tested is readability, not pixel counts: adaptive
    // recovers the text, the global threshold loses the shaded half.
    expect(characterAccuracy(source, adaptive.text)).toBeGreaterThan(0.9)
    expect(characterAccuracy(source, global.text)).toBeLessThan(0.6)
  })

  it('measures skew and straightens the page', () => {
    const { binary, width, height } = renderText(['HARBORPOINT CLAIM', 'MOTOR OWN DAMAGE', 'SURVEYOR REPORT'], { scale: 3 })
    const { gray } = rasterToGray(binary, width, height)
    const rotated = rotateGray(gray, width, height, 6)
    const rotatedBinary = binarize(rotated, width, height)

    const skew = estimateSkew(rotatedBinary, width, height)
    expect(Math.abs(skew - 6)).toBeLessThanOrEqual(1.5)

    const straightened = deskew(rotatedBinary, width, height, skew)
    expect(Math.abs(estimateSkew(straightened.binary, width, height))).toBeLessThanOrEqual(1.5)
  })

  it('flags uploads a reviewer cannot read', () => {
    const blank = assessQuality(new Uint8ClampedArray(120 * 80).fill(240), 120, 80)
    expect(blank.issues).toContain('APPEARS_BLANK')
    expect(blank.readable).toBe(false)

    const dark = assessQuality(new Uint8ClampedArray(120 * 80).fill(8), 120, 80)
    expect(dark.readable).toBe(false)

    const { binary, width, height } = renderText(['GST INVOICE 44073'], { scale: 4 })
    const { gray } = rasterToGray(binary, width, height)
    const good = assessQuality(gray, width, height)
    expect(good.readable).toBe(true)
    expect(good.issues).not.toContain('BLURRY')
  })

  it('detects a skewed upload as a quality issue', () => {
    const { binary, width, height } = renderText(['CLAIM FORM', 'SECTION ONE', 'DECLARATION'], { scale: 3 })
    const { gray } = rasterToGray(binary, width, height)
    const assessment = assessQuality(rotateGray(gray, width, height, 8), width, height)
    expect(assessment.issues).toContain('SKEWED')
  })
})

describe('segmentation', () => {
  it('finds one component per glyph and groups them into lines and words', () => {
    const { binary, width, height } = renderText(['AB CD', 'EF'], { scale: 3 })
    const { boxes } = connectedComponents(binary, width, height)
    expect(boxes.length).toBe(6) // A B C D E F

    const lines = groupIntoLines(boxes)
    expect(lines).toHaveLength(2)
    expect(lines[0].words).toHaveLength(2) // "AB" and "CD"
    expect(lines[1].words).toHaveLength(1)
  })

  it('ignores specks of noise', () => {
    const { binary, width, height } = renderText(['HP'], { scale: 3 })
    binary[0] = 1 // single stray pixel
    const { boxes } = connectedComponents(binary, width, height)
    expect(boxes.length).toBe(2)
  })
})

describe('end-to-end recognition', () => {
  it('reads text back off a rendered page', () => {
    const source = ['CLAIM HP MOT 889211', 'TOTAL 44073.00']
    const { binary, width, height } = renderText(source, { scale: 4 })
    const out = recognize(binary, width, height)
    expect(out.text).toBe(source.join('\n'))
    expect(out.meanConfidence).toBeGreaterThan(0.3)
  })

  it('reads through the real pipeline: PNG bytes to text', () => {
    const source = ['GSTIN 29ABCDE1234F1Z5', 'VEHICLE MH12AB1234']
    const rendered = renderText(source, { scale: 4 })
    const { gray } = rasterToGray(rendered.binary, rendered.width, rendered.height)

    // Through the actual codec, not the in-memory raster.
    const png = encodeGrayPng(rendered.width, rendered.height, gray)
    const decoded = decodeImage(png)
    const quality = assessQuality(decoded.gray, decoded.width, decoded.height)
    expect(quality.readable).toBe(true)

    const out = recognize(quality.binary, decoded.width, decoded.height)
    expect(out.text).toBe(source.join('\n'))
  })

  it('recovers text from a skewed, shadowed photograph of a document', () => {
    const source = ['POLICY HP HLT 220914', 'NET PAYABLE 240450']
    const rendered = renderText(source, { scale: 5, padding: 30 })
    const { gray } = rasterToGray(rendered.binary, rendered.width, rendered.height)
    const degraded = addShadow(rotateGray(gray, rendered.width, rendered.height, 4), rendered.width, rendered.height)

    // prepareDocument straightens the greys before thresholding; doing it the
    // other way round fragments the strokes.
    const prepared = prepareDocument(degraded, rendered.width, rendered.height)
    expect(Math.abs(prepared.skewDegrees - 4)).toBeLessThanOrEqual(1.5)

    const out = recognize(prepared.binary, prepared.width, prepared.height)
    expect(characterAccuracy(source, out.text)).toBeGreaterThan(0.8)
  })

  it('returns nothing for a blank page rather than inventing characters', () => {
    const out = recognize(new Uint8Array(200 * 120), 200, 120)
    expect(out.text).toBe('')
    expect(out.lines).toHaveLength(0)
  })
})
