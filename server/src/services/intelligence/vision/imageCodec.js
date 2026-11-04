import { deflateSync, inflateSync } from 'node:zlib'

/**
 * Image decoding with no dependencies.
 *
 * Node ships no image decoder, and the whole point of this pipeline is that it
 * runs on our own infrastructure with nothing bought in — so the decoder is
 * part of the deliverable rather than an npm install.
 *
 * Decodes to a flat grayscale plane, because every downstream stage
 * (binarisation, deskew, segmentation, glyph matching) works on luminance.
 * Keeping colour would triple the memory for no gain.
 */

/** Rec. 601 luma — the weighting human vision actually uses. */
const luma = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Paeth predictor from the PNG spec (filter type 4). */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reverses the per-scanline filter PNG applies before compression. */
function unfilter(data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = data[pos]
    pos += 1
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x += 1) {
      const raw = data[pos + x]
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0
      const up = y > 0 ? out[prevStart + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel] : 0
      let value
      switch (filter) {
        case 0: value = raw; break
        case 1: value = raw + left; break
        case 2: value = raw + up; break
        case 3: value = raw + ((left + up) >> 1); break
        case 4: value = raw + paeth(left, up, upLeft); break
        default: throw new Error(`Unsupported PNG filter type ${filter}`)
      }
      out[rowStart + x] = value & 0xff
    }
    pos += stride
  }
  return out
}

function decodePng(buffer) {
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (buffer[i] !== PNG_SIGNATURE[i]) throw new Error('Not a PNG')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette = null
  const idat = []

  let pos = 8
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('latin1', pos + 4, pos + 8)
    const body = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      // Interlaced PNGs store seven reduced passes; reassembling them is a
      // different algorithm and these are vanishingly rare for documents.
      if (body[12] !== 0) throw new Error('Interlaced PNG is not supported')
    } else if (type === 'PLTE') {
      palette = Buffer.from(body)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }

  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 is supported)`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`)

  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels)
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels
    if (colorType === 3) {
      const o = raw[p] * 3
      gray[i] = luma(palette[o], palette[o + 1], palette[o + 2])
    } else if (colorType === 0 || colorType === 4) {
      gray[i] = raw[p]
    } else {
      gray[i] = luma(raw[p], raw[p + 1], raw[p + 2])
    }
  }
  return { width, height, gray }
}

// ---------------------------------------------------------------------------
// JPEG (baseline sequential DCT) — what a phone camera produces
// ---------------------------------------------------------------------------
const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
])

function buildHuffmanTable(counts, symbols) {
  // Maps (length, code) -> symbol. Canonical Huffman: codes are assigned in
  // increasing order within each bit length.
  const lookup = new Map()
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length += 1) {
    for (let i = 0; i < counts[length - 1]; i += 1) {
      lookup.set(`${length}:${code}`, symbols[k])
      code += 1
      k += 1
    }
    code <<= 1
  }
  return lookup
}

/** Separable inverse DCT. Straightforward rather than fast — clarity wins here. */
const COS = (() => {
  const t = new Float32Array(64)
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) t[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  }
  return t
})()
const C = (u) => (u === 0 ? Math.SQRT1_2 : 1)

function idct8x8(block, out) {
  const tmp = new Float32Array(64)
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0
      for (let u = 0; u < 8; u += 1) sum += C(u) * block[y * 8 + u] * COS[x * 8 + u]
      tmp[y * 8 + x] = sum / 2
    }
  }
  for (let x = 0; x < 8; x += 1) {
    for (let y = 0; y < 8; y += 1) {
      let sum = 0
      for (let v = 0; v < 8; v += 1) sum += C(v) * tmp[v * 8 + x] * COS[y * 8 + v]
      out[y * 8 + x] = Math.max(0, Math.min(255, Math.round(sum / 2) + 128))
    }
  }
}

function decodeJpeg(buffer) {
  const quant = {}
  const huffDC = {}
  const huffAC = {}
  let frame = null
  let restartInterval = 0
  let pos = 2

  while (pos < buffer.length) {
    if (buffer[pos] !== 0xff) { pos += 1; continue }
    const marker = buffer[pos + 1]
    pos += 2
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = buffer.readUInt16BE(pos)
    const body = buffer.subarray(pos + 2, pos + length)

    if (marker === 0xdb) {
      let p = 0
      while (p < body.length) {
        const precision = body[p] >> 4
        const id = body[p] & 15
        p += 1
        const table = new Int32Array(64)
        for (let i = 0; i < 64; i += 1) {
          table[ZIGZAG[i]] = precision ? body.readUInt16BE(p + i * 2) : body[p + i]
        }
        p += precision ? 128 : 64
        quant[id] = table
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      frame = {
        height: body.readUInt16BE(1),
        width: body.readUInt16BE(3),
        components: [],
      }
      const count = body[5]
      for (let i = 0; i < count; i += 1) {
        const o = 6 + i * 3
        frame.components.push({ id: body[o], h: body[o + 1] >> 4, v: body[o + 1] & 15, tq: body[o + 2] })
      }
    } else if (marker === 0xc2) {
      throw new Error('Progressive JPEG is not supported — re-save as baseline')
    } else if (marker === 0xc4) {
      let p = 0
      while (p < body.length) {
        const cls = body[p] >> 4
        const id = body[p] & 15
        p += 1
        const counts = body.subarray(p, p + 16)
        p += 16
        let total = 0
        for (const n of counts) total += n
        const symbols = body.subarray(p, p + total)
        p += total
        const table = buildHuffmanTable(counts, symbols)
        if (cls === 0) huffDC[id] = table
        else huffAC[id] = table
      }
    } else if (marker === 0xdd) {
      restartInterval = body.readUInt16BE(0)
    } else if (marker === 0xda) {
      const scanCount = body[0]
      const scan = []
      for (let i = 0; i < scanCount; i += 1) {
        const id = body[1 + i * 2]
        const tables = body[2 + i * 2]
        const comp = frame.components.find((c) => c.id === id)
        scan.push({ comp, dc: tables >> 4, ac: tables & 15 })
      }
      return decodeScan(buffer, pos + length, frame, scan, quant, huffDC, huffAC, restartInterval)
    }
    pos += length
  }
  throw new Error('No JPEG scan data found')
}

function decodeScan(buffer, start, frame, scan, quant, huffDC, huffAC, restartInterval) {
  const { width, height } = frame
  const maxH = Math.max(...frame.components.map((c) => c.h))
  const maxV = Math.max(...frame.components.map((c) => c.v))
  const mcuW = maxH * 8
  const mcuH = maxV * 8
  const mcusX = Math.ceil(width / mcuW)
  const mcusY = Math.ceil(height / mcuH)

  // Only the luminance plane is kept; chroma is decoded and discarded, since
  // every downstream stage works on brightness alone.
  const y0 = scan[0]
  const planeW = mcusX * y0.comp.h * 8
  const plane = new Uint8ClampedArray(planeW * mcusY * y0.comp.v * 8)

  let bitPos = start * 8
  const readBit = () => {
    const byteIndex = bitPos >> 3
    const byte = buffer[byteIndex]
    // 0xFF00 is a stuffed byte: the 0x00 is padding, not data.
    if (byte === 0xff && buffer[byteIndex + 1] !== 0x00) return null
    const bit = (byte >> (7 - (bitPos & 7))) & 1
    bitPos += 1
    if ((bitPos & 7) === 0 && byte === 0xff) bitPos += 8
    return bit
  }
  const decodeHuff = (table) => {
    let code = 0
    for (let length = 1; length <= 16; length += 1) {
      const bit = readBit()
      if (bit === null) return null
      code = (code << 1) | bit
      const symbol = table.get(`${length}:${code}`)
      if (symbol !== undefined) return symbol
    }
    return null
  }
  const receiveExtend = (size) => {
    if (size === 0) return 0
    let value = 0
    for (let i = 0; i < size; i += 1) {
      const bit = readBit()
      if (bit === null) return 0
      value = (value << 1) | bit
    }
    // Negative values are stored as the ones' complement of their magnitude.
    return value < 1 << (size - 1) ? value - (1 << size) + 1 : value
  }

  const preds = new Map(frame.components.map((c) => [c.id, 0]))
  const block = new Float32Array(64)
  const pixels = new Uint8ClampedArray(64)
  let mcu = 0

  for (let my = 0; my < mcusY; my += 1) {
    for (let mx = 0; mx < mcusX; mx += 1) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        // Resync: skip to the byte after the RSTn marker and reset predictors.
        bitPos = ((bitPos + 7) >> 3) << 3
        while (bitPos >> 3 < buffer.length && !(buffer[bitPos >> 3] === 0xff && buffer[(bitPos >> 3) + 1] >= 0xd0 && buffer[(bitPos >> 3) + 1] <= 0xd7)) bitPos += 8
        bitPos += 16
        for (const key of preds.keys()) preds.set(key, 0)
      }
      mcu += 1

      for (const entry of scan) {
        const { comp } = entry
        for (let by = 0; by < comp.v; by += 1) {
          for (let bx = 0; bx < comp.h; bx += 1) {
            block.fill(0)
            const table = quant[comp.tq]
            const size = decodeHuff(huffDC[entry.dc])
            if (size === null) return finish(plane, planeW, width, height)
            const diff = receiveExtend(size)
            const dc = preds.get(comp.id) + diff
            preds.set(comp.id, dc)
            block[0] = dc * table[0]

            for (let k = 1; k < 64;) {
              const rs = decodeHuff(huffAC[entry.ac])
              if (rs === null) return finish(plane, planeW, width, height)
              const run = rs >> 4
              const magnitude = rs & 15
              if (magnitude === 0) {
                if (run !== 15) break // end of block
                k += 16
                continue
              }
              k += run
              if (k > 63) break
              const index = ZIGZAG[k]
              block[index] = receiveExtend(magnitude) * table[index]
              k += 1
            }

            if (entry === y0) {
              idct8x8(block, pixels)
              const originX = (mx * comp.h + bx) * 8
              const originY = (my * comp.v + by) * 8
              for (let py = 0; py < 8; py += 1) {
                const row = (originY + py) * planeW + originX
                for (let px = 0; px < 8; px += 1) plane[row + px] = pixels[py * 8 + px]
              }
            }
          }
        }
      }
    }
  }
  return finish(plane, planeW, width, height)
}

/** Crops the padded MCU plane back to the declared image size, scaling if the
 *  luminance component was subsampled relative to the frame. */
function finish(plane, planeW, width, height) {
  const gray = new Uint8ClampedArray(width * height)
  const planeH = plane.length / planeW
  const sx = planeW / width
  const sy = planeH / height
  for (let y = 0; y < height; y += 1) {
    const srcRow = Math.min(planeH - 1, Math.floor(y * sy)) * planeW
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = plane[srcRow + Math.min(planeW - 1, Math.floor(x * sx))]
    }
  }
  return { width, height, gray }
}

// ---------------------------------------------------------------------------

export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && PNG_SIGNATURE.every((b, i) => buffer[i] === b)
}

export function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8
}

/**
 * @returns {{width: number, height: number, gray: Uint8ClampedArray}}
 * @throws when the format is unsupported — WebP (VP8) is a separate codec
 *         entirely and is reported rather than silently mishandled.
 */
export function decodeImage(buffer) {
  if (isPng(buffer)) return decodePng(buffer)
  if (isJpeg(buffer)) return decodeJpeg(buffer)
  if (Buffer.isBuffer(buffer) && buffer.toString('latin1', 8, 12) === 'WEBP') {
    throw new Error('WebP is not supported by this decoder — convert to PNG or JPEG')
  }
  throw new Error('Unrecognised image format')
}

/** Minimal 8-bit grayscale PNG writer, for dumping intermediate stages while debugging. */
export function encodeGrayPng(width, height, gray) {
  const raw = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    for (let x = 0; x < width; x += 1) raw[y * (width + 1) + 1 + x] = gray[y * width + x]
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    body.copy(out, 8)
    out.writeInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) | 0
}
