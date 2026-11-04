/**
 * Document image preprocessing and quality assessment.
 *
 * Written for how Indian claim documents actually arrive: a phone photo taken
 * at an angle, under a tube light, of a thermal-printed garage bill. That means
 * uneven illumination across the page, rotation of a few degrees, and shadow
 * gradients — none of which a global threshold survives.
 *
 * The quality metrics here are worth as much as the OCR. A reviewer who learns
 * in one second that an upload is too blurry to read can request a re-shoot
 * immediately, instead of discovering it after opening the file.
 */

/**
 * Otsu's method: picks the threshold that minimises variance within the two
 * resulting groups. Good for evenly lit scans, poor for photos with a shadow.
 */
export function otsuThreshold(gray) {
  const histogram = new Int32Array(256)
  for (const value of gray) histogram[value] += 1

  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]

  let sumBackground = 0
  let weightBackground = 0
  let bestVariance = -1
  // On a clean two-tone image every threshold between the two peaks scores
  // identically. Taking the first would sit the threshold exactly on the ink
  // value, where a single grey level of noise flips the classification; the
  // midpoint of the tied plateau sits safely between the peaks.
  let plateauStart = 0
  let plateauEnd = 0
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue
    const weightForeground = total - weightBackground
    if (weightForeground === 0) break
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      plateauStart = t
      plateauEnd = t
    } else if (variance === bestVariance) {
      plateauEnd = t
    }
  }
  return Math.round((plateauStart + plateauEnd) / 2)
}

/** Summed-area table, so every window mean below is O(1) regardless of radius. */
function integralImages(gray, width, height) {
  const sum = new Float64Array((width + 1) * (height + 1))
  const sumSquares = new Float64Array((width + 1) * (height + 1))
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0
    let rowSquares = 0
    for (let x = 1; x <= width; x += 1) {
      const value = gray[(y - 1) * width + (x - 1)]
      rowSum += value
      rowSquares += value * value
      sum[y * (width + 1) + x] = sum[(y - 1) * (width + 1) + x] + rowSum
      sumSquares[y * (width + 1) + x] = sumSquares[(y - 1) * (width + 1) + x] + rowSquares
    }
  }
  return { sum, sumSquares }
}

/**
 * Sauvola adaptive binarisation: thresholds each pixel against the mean and
 * standard deviation of its neighbourhood, so a shadow across half the page
 * no longer swallows the text under it. This is the single most important
 * step for phone photos; Otsu alone loses the shaded half entirely.
 *
 * @returns {Uint8Array} 1 = ink, 0 = background
 */
export function binarize(gray, width, height, { windowSize = 0, k = 0.2, R = 128 } = {}) {
  // A window near the stroke width works best; scale it to the page.
  const w = windowSize || Math.max(15, Math.round(Math.min(width, height) / 30) | 1)
  const radius = w >> 1
  const { sum, sumSquares } = integralImages(gray, width, height)
  const out = new Uint8Array(width * height)

  const area = (x0, y0, x1, y1, table) =>
    table[y1 * (width + 1) + x1] - table[y0 * (width + 1) + x1] - table[y1 * (width + 1) + x0] + table[y0 * (width + 1) + x0]

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height, y + radius + 1)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width, x + radius + 1)
      const count = (x1 - x0) * (y1 - y0)
      const mean = area(x0, y0, x1, y1, sum) / count
      const variance = area(x0, y0, x1, y1, sumSquares) / count - mean * mean
      const stdDev = Math.sqrt(Math.max(0, variance))
      const threshold = mean * (1 + k * (stdDev / R - 1))
      out[y * width + x] = gray[y * width + x] < threshold ? 1 : 0
    }
  }
  return out
}

/**
 * Estimates page rotation by projecting ink onto the horizontal axis at a
 * range of angles. Text lines produce sharp peaks and deep troughs when the
 * projection is aligned with them, so the angle maximising the variance of the
 * row-sum profile is the skew.
 *
 * @returns {number} degrees; positive means the page is rotated clockwise
 */
export function estimateSkew(binary, width, height, { maxDegrees = 12, step = 0.5 } = {}) {
  // Downsample: skew is a global property and full resolution is wasted here.
  const scale = Math.max(1, Math.round(Math.max(width, height) / 600))
  const w = Math.floor(width / scale)
  const h = Math.floor(height / scale)
  const small = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) small[y * w + x] = binary[y * scale * width + x * scale]
  }

  let bestAngle = 0
  let bestScore = -1
  for (let angle = -maxDegrees; angle <= maxDegrees; angle += step) {
    const radians = (angle * Math.PI) / 180
    const shear = Math.tan(radians)
    const profile = new Float64Array(h)
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!small[y * w + x]) continue
        const row = Math.round(y - (x - w / 2) * shear)
        if (row >= 0 && row < h) profile[row] += 1
      }
    }
    let mean = 0
    for (const v of profile) mean += v
    mean /= h
    let variance = 0
    for (const v of profile) variance += (v - mean) ** 2
    if (variance > bestScore) {
      bestScore = variance
      bestAngle = angle
    }
  }
  return bestAngle
}

/** Rotates a binary image by -angle, straightening the page. Nearest-neighbour
 *  is adequate because the input is already one bit per pixel. */
export function deskew(binary, width, height, angle) {
  if (Math.abs(angle) < 0.25) return { binary, width, height }
  const radians = (-angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = width / 2
  const cy = height / 2
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const sx = Math.round(cx + dx * cos + dy * sin)
      const sy = Math.round(cy - dx * sin + dy * cos)
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) out[y * width + x] = binary[sy * width + sx]
    }
  }
  return { binary: out, width, height }
}

/**
 * Rotates a grayscale image with bilinear sampling.
 *
 * Straightening must happen here, on continuous tone, and not on the binary
 * image. Rotating one-bit pixels with nearest-neighbour sampling shreds thin
 * strokes — characters break into pieces and the component analysis then sees
 * fragments rather than glyphs. Interpolating greys first and thresholding
 * afterwards keeps strokes intact.
 */
export function deskewGray(gray, width, height, angle, background = 255) {
  if (Math.abs(angle) < 0.25) return gray
  const radians = (-angle * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const cx = width / 2
  const cy = height / 2
  const out = new Uint8ClampedArray(width * height).fill(background)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const sx = cx + dx * cos + dy * sin
      const sy = cy - dx * sin + dy * cos
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue
      const fx = sx - x0
      const fy = sy - y0
      const i = y0 * width + x0
      out[y * width + x] =
        gray[i] * (1 - fx) * (1 - fy) +
        gray[i + 1] * fx * (1 - fy) +
        gray[i + width] * (1 - fx) * fy +
        gray[i + width + 1] * fx * fy
    }
  }
  return out
}

const dilate = (src, width, height) => {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0
      for (let dy = -1; dy <= 1 && !on; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          if (src[ny * width + nx]) { on = 1; break }
        }
      }
      out[y * width + x] = on
    }
  }
  return out
}

const erode = (src, width, height) => {
  const out = new Uint8Array(src.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let all = 1
      for (let dy = -1; dy <= 1 && all; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !src[ny * width + nx]) { all = 0; break }
        }
      }
      out[y * width + x] = all
    }
  }
  return out
}

/**
 * Morphological closing — dilate, then erode.
 *
 * Rotation and thresholding together can sever a thin stroke, and a character
 * that splits in two is then read as two unknown blobs rather than one letter.
 * Closing bridges those one- and two-pixel breaks without fattening the glyph,
 * because the erode undoes the dilation everywhere the gap was not filled.
 */
export function closeGaps(binary, width, height) {
  return erode(dilate(binary, width, height), width, height)
}

/**
 * The full correct sequence for a document photograph: threshold once to
 * measure skew, straighten the greys, threshold the straightened image for
 * real, then repair strokes the rotation broke.
 *
 * @returns {{binary: Uint8Array, width: number, height: number, skewDegrees: number}}
 */
export function prepareDocument(gray, width, height) {
  const probe = binarize(gray, width, height)
  const skew = estimateSkew(probe, width, height)
  if (Math.abs(skew) < 0.25) return { binary: probe, width, height, skewDegrees: 0 }
  const straightened = deskewGray(gray, width, height, skew)
  return {
    binary: closeGaps(binarize(straightened, width, height), width, height),
    width,
    height,
    skewDegrees: Number(skew.toFixed(2)),
  }
}

/**
 * Readability assessment, computed before any attempt to recognise text.
 *
 * `sharpness` is the variance of the Laplacian — the standard blur measure.
 * A sharp document has strong second derivatives at every stroke edge; a
 * motion-blurred or out-of-focus photo has almost none.
 */
export function assessQuality(gray, width, height) {
  let min = 255
  let max = 0
  let sum = 0
  for (const v of gray) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const mean = sum / gray.length

  let laplacianSum = 0
  let laplacianSquares = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const value =
        -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width]
      laplacianSum += value
      laplacianSquares += value * value
      count += 1
    }
  }
  const laplacianMean = count ? laplacianSum / count : 0
  const sharpness = count ? laplacianSquares / count - laplacianMean * laplacianMean : 0

  const binary = binarize(gray, width, height)
  let ink = 0
  for (const v of binary) ink += v
  const inkRatio = ink / binary.length

  const issues = []
  // Thresholds are calibrated for document photos, where ink covers a few
  // percent of the page. A blank scan and a black frame both land near the
  // extremes and are equally useless to a reviewer.
  if (inkRatio < 0.005) issues.push('APPEARS_BLANK')
  if (inkRatio > 0.6) issues.push('TOO_DARK')
  if (max - min < 40) issues.push('LOW_CONTRAST')
  if (sharpness < 50) issues.push('BLURRY')

  const skew = issues.includes('APPEARS_BLANK') ? 0 : estimateSkew(binary, width, height)
  if (Math.abs(skew) > 3) issues.push('SKEWED')

  return {
    width,
    height,
    meanBrightness: Math.round(mean),
    contrast: max - min,
    sharpness: Math.round(sharpness),
    inkRatio: Number(inkRatio.toFixed(4)),
    skewDegrees: Number(skew.toFixed(2)),
    issues,
    readable: !issues.some((i) => ['APPEARS_BLANK', 'TOO_DARK', 'LOW_CONTRAST', 'BLURRY'].includes(i)),
    binary,
  }
}
