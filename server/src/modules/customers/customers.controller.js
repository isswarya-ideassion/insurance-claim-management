import { ok } from '../../utils/http.js'
import * as service from './customers.service.js'

export async function list(req, res) {
  const { items, meta } = await service.listCustomers(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function get(req, res) {
  ok(res, await service.getCustomer(req.ctx, req.params.id))
}

export async function exportCsv(req, res) {
  const { csv, rows, truncated } = await service.exportCustomers(req.ctx, req.validatedQuery)
  const stamp = new Date().toISOString().slice(0, 10)
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="customer-records-${stamp}.csv"`,
    'Cache-Control': 'private, no-store',
    'X-Export-Rows': String(rows),
    'X-Export-Truncated': String(truncated),
  })
  res.send(csv)
}

export async function downloadDocument(req, res) {
  const { doc, buffer } = await service.downloadCustomerDocument(req.ctx, req.params.id, req.params.documentId)
  res.set({
    'Content-Type': doc.mime_type,
    'Content-Length': String(buffer.length),
    'Content-Disposition': `${req.validatedQuery.disposition}; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  })
  res.end(buffer)
}
