/**
 * Optical character recognition, built from scratch.
 *
 * Three stages: connected-component analysis finds candidate glyphs, geometric
 * grouping assembles them into lines and words, and a nearest-neighbour
 * classifier labels each glyph against trained templates.
 *
 * Honest about what this is. It recognises MACHINE-PRINTED text whose shapes
 * resemble its trained templates. It is not a neural OCR: it will not read
 * handwriting, and an unfamiliar typeface needs templates trained from labelled
 * samples before accuracy is usable. `trainTemplates()` exists for exactly
 * that — the classifier is meant to be taught our own documents, not shipped
 * frozen.
 *
 * The built-in template set is a 5x7 bitmap font. It is deliberately included
 * so the whole pipeline can be proven end to end — render known text, decode
 * it, read it back — without depending on a font file being present.
 */

// ---------------------------------------------------------------------------
// Built-in 5x7 template font
// ---------------------------------------------------------------------------
const FONT_5X7 = {
  '0': '01110 10001 10011 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11100 10010 10001 10001 10001 10010 11100',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 00100 01000',
  ':': '00000 01100 01100 00000 01100 01100 00000',
  '/': '00001 00010 00010 00100 01000 01000 10000',
}

const glyphRows = (spec) => spec.split(' ')

/** Renders text into a binary raster. Used for training and for proving the
 *  recogniser end to end. */
export function renderText(lines, { scale = 3, padding = 12, spacing = 1 } = {}) {
  const rows = Array.isArray(lines) ? lines : [lines]
  const charW = (5 + spacing) * scale
  const lineH = (7 + 2) * scale
  const width = padding * 2 + Math.max(...rows.map((r) => r.length)) * charW
  const height = padding * 2 + rows.length * lineH
  const binary = new Uint8Array(width * height)

  rows.forEach((text, lineIndex) => {
    const originY = padding + lineIndex * lineH
    ;[...text.toUpperCase()].forEach((ch, charIndex) => {
      const spec = FONT_5X7[ch]
      if (!spec) return
      const originX = padding + charIndex * charW
      glyphRows(spec).forEach((row, gy) => {
        for (let gx = 0; gx < 5; gx += 1) {
          if (row[gx] !== '1') continue
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              const px = originX + gx * scale + sx
              const py = originY + gy * scale + sy
              if (px < width && py < height) binary[py * width + px] = 1
            }
          }
        }
      })
    })
  })
  return { binary, width, height }
}

/** Grayscale view of a rendered raster (ink dark on white), for feeding the
 *  real preprocessing path in tests. */
export function rasterToGray(binary, width, height) {
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0; i < binary.length; i += 1) gray[i] = binary[i] ? 24 : 236
  return { gray, width, height }
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------
/**
 * Two-pass labelling with 8-connectivity, returning one box per ink blob.
 * Iterative flood fill rather than recursion — a full-page ink region would
 * blow the call stack on a recursive implementation.
 */
export function connectedComponents(binary, width, height, { minPixels = 4 } = {}) {
  const labels = new Int32Array(width * height).fill(-1)
  const boxes = []
  const stack = []

  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || labels[start] !== -1) continue
    const id = boxes.length
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let pixels = 0

    stack.push(start)
    labels[start] = id
    while (stack.length) {
      const index = stack.pop()
      const x = index % width
      const y = (index / width) | 0
      pixels += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (binary[n] && labels[n] === -1) {
            labels[n] = id
            stack.push(n)
          }
        }
      }
    }

    if (pixels >= minPixels) {
      boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, pixels })
    } else {
      boxes.push(null) // speck of noise; keeps ids aligned with labels
    }
  }
  return { boxes: boxes.filter(Boolean), labels }
}

/**
 * Groups glyph boxes into text lines by vertical overlap, then into words by
 * horizontal gap. The gap threshold is derived from the median glyph width on
 * each line, so it adapts to font size instead of assuming one.
 */
export function groupIntoLines(boxes) {
  if (!boxes.length) return []
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines = []

  for (const box of sorted) {
    const centre = box.y + box.h / 2
    const line = lines.find((l) => centre >= l.top - l.height * 0.3 && centre <= l.bottom + l.height * 0.3)
    if (line) {
      line.boxes.push(box)
      line.top = Math.min(line.top, box.y)
      line.bottom = Math.max(line.bottom, box.y + box.h)
      line.height = line.bottom - line.top
    } else {
      lines.push({ boxes: [box], top: box.y, bottom: box.y + box.h, height: box.h })
    }
  }

  for (const line of lines) {
    line.boxes.sort((a, b) => a.x - b.x)
    const widths = line.boxes.map((b) => b.w).sort((a, b) => a - b)
    const medianWidth = widths[Math.floor(widths.length / 2)] || 1
    const wordGap = medianWidth * 0.8
    line.words = []
    let current = [line.boxes[0]]
    for (let i = 1; i < line.boxes.length; i += 1) {
      const prev = line.boxes[i - 1]
      const box = line.boxes[i]
      if (box.x - (prev.x + prev.w) > wordGap) {
        line.words.push(current)
        current = [box]
      } else current.push(box)
    }
    line.words.push(current)
  }
  return lines.sort((a, b) => a.top - b.top)
}

// ---------------------------------------------------------------------------
// Glyph classification
// ---------------------------------------------------------------------------
const GRID = 8

/**
 * Normalises a glyph to a fixed grid of ink-coverage fractions.
 *
 * Coverage rather than a binary resample: a cell that is one-third ink scores
 * 0.33, which keeps the descriptor stable when the same character appears at
 * different sizes. A hard resample loses thin strokes at small scales.
 */
export function glyphDescriptor(binary, width, box) {
  const cells = new Float32Array(GRID * GRID)
  const counts = new Float32Array(GRID * GRID)
  for (let y = 0; y < box.h; y += 1) {
    const gy = Math.min(GRID - 1, Math.floor((y / box.h) * GRID))
    for (let x = 0; x < box.w; x += 1) {
      const gx = Math.min(GRID - 1, Math.floor((x / box.w) * GRID))
      const cell = gy * GRID + gx
      counts[cell] += 1
      if (binary[(box.y + y) * width + (box.x + x)]) cells[cell] += 1
    }
  }
  const descriptor = new Float32Array(GRID * GRID + 1)
  for (let i = 0; i < cells.length; i += 1) descriptor[i] = counts[i] ? cells[i] / counts[i] : 0
  // Aspect ratio separates shapes that normalise to similar grids — most
  // usefully '.' and ':' from 'O', and '-' from '_'.
  descriptor[GRID * GRID] = Math.min(2, box.w / box.h)
  return descriptor
}

const distance = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum)
}

/** Builds templates from labelled glyph samples: `[{char, binary, width, box}]`. */
export function trainTemplates(samples) {
  const byChar = new Map()
  for (const s of samples) {
    const descriptor = glyphDescriptor(s.binary, s.width, s.box)
    if (!byChar.has(s.char)) byChar.set(s.char, [])
    byChar.get(s.char).push(descriptor)
  }
  // Several exemplars per character are kept rather than averaged — averaging
  // two genuinely different renderings produces a centroid matching neither.
  return [...byChar.entries()].flatMap(([char, descriptors]) =>
    descriptors.slice(0, 8).map((descriptor) => ({ char, descriptor })),
  )
}

/** Templates for the built-in font, rendered at several scales so the
 *  classifier is not brittle to glyph size. */
export function builtinTemplates() {
  const samples = []
  for (const char of Object.keys(FONT_5X7)) {
    for (const scale of [2, 3, 5]) {
      const { binary, width, height } = renderText([char], { scale, padding: 2, spacing: 1 })
      const { boxes } = connectedComponents(binary, width, height, { minPixels: 1 })
      if (!boxes.length) continue
      // Characters like ':' split into separate blobs; merge to one box.
      const box = boxes.reduce((acc, b) => ({
        x: Math.min(acc.x, b.x),
        y: Math.min(acc.y, b.y),
        w: Math.max(acc.x + acc.w, b.x + b.w) - Math.min(acc.x, b.x),
        h: Math.max(acc.y + acc.h, b.y + b.h) - Math.min(acc.y, b.y),
      }))
      samples.push({ char, binary, width, box })
    }
  }
  return trainTemplates(samples)
}

let cachedTemplates = null
const defaultTemplates = () => (cachedTemplates ||= builtinTemplates())

/**
 * Reads text from a binarised page.
 *
 * @returns {{text: string, lines: object[], meanConfidence: number}}
 */
export function recognize(binary, width, height, { templates = defaultTemplates(), minConfidence = 0.35 } = {}) {
  const { boxes } = connectedComponents(binary, width, height)
  if (!boxes.length) return { text: '', lines: [], meanConfidence: 0 }

  // Drop blobs far larger than the typical glyph — rules, borders, stamps and
  // photographs are not characters, and feeding them to the classifier only
  // produces confident nonsense.
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)]
  const glyphs = boxes.filter((b) => b.h <= medianHeight * 3 && b.w <= medianHeight * 4)

  const lines = groupIntoLines(glyphs)
  const confidences = []
  const output = []

  for (const line of lines) {
    const words = []
    for (const word of line.words) {
      let text = ''
      for (const box of word) {
        const descriptor = glyphDescriptor(binary, width, box)
        let best = null
        let bestDistance = Infinity
        for (const template of templates) {
          const d = distance(descriptor, template.descriptor)
          if (d < bestDistance) {
            bestDistance = d
            best = template.char
          }
        }
        // The margin must be measured against the best template of a DIFFERENT
        // character. Several templates per character are stored (one per
        // rendered scale), so comparing to the next-best template would almost
        // always compare a letter against itself at another size, collapsing
        // the margin to zero and rejecting correct reads.
        let rival = Infinity
        for (const template of templates) {
          if (template.char === best) continue
          const d = distance(descriptor, template.descriptor)
          if (d < rival) rival = d
        }
        const margin = Number.isFinite(rival) && rival > 0 ? (rival - bestDistance) / rival : 1
        const confidence = Math.max(0, Math.min(1, margin * 2))
        confidences.push(confidence)
        text += confidence >= minConfidence ? best : '?'
      }
      if (text) words.push(text)
    }
    if (words.length) output.push({ top: line.top, text: words.join(' ') })
  }

  return {
    text: output.map((l) => l.text).join('\n'),
    lines: output,
    meanConfidence: confidences.length
      ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3))
      : 0,
  }
}

export const SUPPORTED_CHARACTERS = Object.keys(FONT_5X7)
