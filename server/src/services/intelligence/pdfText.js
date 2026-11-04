import { inflateSync, unzipSync } from 'node:zlib'

/**
 * Reads the text layer out of a PDF, with no external dependency.
 *
 * This is the half of the document-reviewer problem that is solvable without a
 * vision model. A large share of Indian claim paperwork arrives already
 * digital — hospital bills from an HIS, GST tax invoices, e-FIR copies, policy
 * schedules, garage estimates — and those carry a real text layer.
 *
 * What this cannot do is read a photograph. A phone picture of a handwritten
 * garage estimate has no text layer, and nothing here will invent one; that
 * case still needs OCR or a vision model. `hasTextLayer` exists so the caller
 * can tell the two apart honestly instead of silently returning "".
 */

/** PDF string escapes inside ( ... ) literals. */
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }

function decodeLiteral(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === undefined) break
    if (ESCAPES[next] !== undefined) {
      out += ESCAPES[next]
      i += 1
      continue
    }
    // Octal character code: \ddd
    const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))
    if (octal) {
      out += String.fromCharCode(parseInt(octal[0], 8))
      i += octal[0].length
      continue
    }
    i += 1
  }
  return out
}

/** Pulls every content stream out of the file, inflating the compressed ones. */
function contentStreams(buffer) {
  const streams = []
  const latin1 = buffer.toString('latin1')
  const re = /stream\r?\n?/g
  let match
  while ((match = re.exec(latin1)) !== null) {
    const start = match.index + match[0].length
    const end = latin1.indexOf('endstream', start)
    if (end === -1) continue
    const slice = buffer.subarray(start, end)
    // Only the dictionary immediately before the stream tells us the filter.
    const header = latin1.slice(Math.max(0, match.index - 400), match.index)
    if (/\/FlateDecode/.test(header)) {
      try {
        streams.push(inflateSync(slice).toString('latin1'))
      } catch {
        try {
          streams.push(unzipSync(slice).toString('latin1'))
        } catch {
          // A stream we cannot inflate is skipped rather than failing the file;
          // an image XObject lands here and legitimately has no text.
        }
      }
    } else {
      streams.push(slice.toString('latin1'))
    }
    re.lastIndex = end
  }
  return streams
}

/**
 * Extracts text in reading order from the Tj and TJ operators.
 * The positioning operators (Td, TD, ET and the next-line operator) introduce
 * line breaks, which is what keeps a label next to its value
 * ("Policy No: HP-1234") instead of collapsing the page into one run.
 */
function textFromStream(stream) {
  let out = ''
  const re = /\((?:[^()\\]|\\.)*\)\s*Tj|\[(?:[^\][\\]|\\.)*\]\s*TJ|T\*|Td|TD|ET/g
  let match
  while ((match = re.exec(stream)) !== null) {
    const token = match[0]
    if (token === 'T*' || token === 'Td' || token === 'TD' || token === 'ET') {
      if (out && !out.endsWith('\n')) out += '\n'
      continue
    }
    if (token.endsWith('Tj')) {
      const literal = /\(((?:[^()\\]|\\.)*)\)/.exec(token)
      if (literal) out += decodeLiteral(literal[1])
      continue
    }
    // TJ takes an array of strings and kerning numbers; keep only the strings.
    for (const piece of token.matchAll(/\(((?:[^()\\]|\\.)*)\)/g)) out += decodeLiteral(piece[1])
  }
  return out
}

/** @returns {{text: string, hasTextLayer: boolean, pages: number}} */
export function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    return { text: '', hasTextLayer: false, pages: 0 }
  }
  const streams = contentStreams(buffer)
  const parts = streams.map(textFromStream).filter((t) => t.trim())
  const text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
  return {
    text,
    // A handful of stray glyphs is not a text layer; it is a scan with a logo.
    hasTextLayer: text.replace(/\s/g, '').length >= 32,
    pages: pages || parts.length,
  }
}
