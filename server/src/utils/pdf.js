/**
 * Minimal text-only PDF writer for generated letters (A4, Helvetica, wrapped
 * and paginated). The standard PDF fonts cannot draw "₹", so it is written as
 * "Rs."; other characters outside Latin-1 are replaced with "?".
 */
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN = 64
const FONT_SIZE = 11
const LINE_HEIGHT = 15
const MAX_CHARS = 92
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT)

const toLatin1 = (s) => String(s).replace(/₹\s?/g, 'Rs. ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\xff]/g, '?')
const escape = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`)

/** Splits text into lines of at most MAX_CHARS, keeping blank lines between paragraphs. */
export function wrapText(text, width = MAX_CHARS) {
  const out = []
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if ((line ? `${line} ${word}` : word).length > width) {
        if (line) out.push(line)
        line = word.length > width ? word.slice(0, width) : word
      } else line = line ? `${line} ${word}` : word
    }
    if (line) out.push(line)
  }
  return out
}

export function buildTextPdf(text) {
  const lines = wrapText(toLatin1(text))
  const pages = []
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE))

  // Objects: 1 catalog, 2 pages, 3 font, then a page and a content stream per page.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']
  const kids = []
  for (const pageLines of pages) {
    const stream = pageLines
      .map((l, i) => `BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${PAGE_HEIGHT - MARGIN - i * LINE_HEIGHT} Td (${escape(l)}) Tj ET`)
      .join('\n')
    const pageId = objects.length + 1
    kids.push(`${pageId} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`

  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}
