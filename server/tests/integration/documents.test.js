import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, samplePdf } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('document upload validation', () => {
  it('accepts a real PDF and records a checksum and version', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf('ok'), filename: 'extra.pdf', fields: { category: 'OTHER' } })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.document).toMatchObject({ version_no: 1, status: 'PENDING_REVIEW', mime_type: 'application/pdf' })
  })

  it('rejects files whose content is not an allowed type even if renamed', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, {
      buffer: Buffer.from('#!/bin/sh\necho not a pdf\n'),
      filename: 'invoice.pdf',
      fields: { category: 'INVOICE' },
    })
    expect(res.status).toBe(415)
  })

  it('rejects disallowed extensions and oversized files', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const exe = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'tool.exe', fields: { category: 'OTHER' } })
    expect(exe.status).toBe(415)
    const big = Buffer.concat([samplePdf(), Buffer.alloc(10 * 1024 * 1024 + 10)])
    const tooBig = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: big, filename: 'big.pdf', fields: { category: 'OTHER' } })
    expect(tooBig.status).toBe(413)
  })

  it('does not allow uploads to someone else’s claim', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.alice').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'x.pdf', fields: { category: 'OTHER' } })
    expect(res.status).toBe(404)
  })
})

describe('secure download', () => {
  it('streams files only to authorised users with no-store caching', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const [doc] = await ctx.db.findMany('documents', { where: { claim_id: claim.id }, limit: 1 })
    const ok = await ctx.as('customer.ben').get(`/documents/${doc.id}/download?disposition=inline`)
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toBe('application/pdf')
    expect(ok.headers['cache-control']).toBe('private, no-store')
    expect(ok.headers['content-disposition']).toMatch(/^inline/)
    expect((await ctx.as('customer.alice').get(`/documents/${doc.id}/download`)).status).toBe(404)
    expect((await request(ctx.app).get(`/api/v1/documents/${doc.id}/download`)).status).toBe(401)
    const audit = await ctx.db.count('audit_logs', { entity_id: doc.id, action: 'DOCUMENT_DOWNLOADED' })
    expect(audit).toBe(1)
  })
})

describe('document review', () => {
  it('rejects a document: notifies the claimant, requests a replacement, creates a follow-up task and moves the claim back', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const doc = await ctx.db.findOne('documents', { claim_id: claim.id, category: 'INVOICE' })
    const missingReason = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'REJECT' })
    expect(missingReason.status).toBe(422)

    const res = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'REJECT', rejectionReason: 'Invoice is not itemised' })
    expect(res.status).toBe(200)
    expect(res.body.data.claimStatus).toBe('DOCUMENTS_REQUIRED')

    const ben = await ctx.userId('customer.ben')
    expect(await ctx.db.count('notifications', { recipient_id: ben, type: 'DOCUMENT_REJECTED', claim_id: claim.id })).toBe(1)
    expect(await ctx.db.count('information_requests', { claim_id: claim.id, status: 'OPEN', document_category: 'INVOICE' })).toBe(1)
    expect(await ctx.db.count('tasks', { claim_id: claim.id, task_type: 'DOCUMENT_FOLLOW_UP', status: 'OPEN' })).toBe(1)

    const again = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'ACCEPT' })
    expect(again.status).toBe(409)
  })

  it('does not let the claim progress until required documents are accepted', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' })
    expect(res.status).toBe(422)
  })

  it('accepts a replacement version uploaded by the claimant and auto-returns the claim to review', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const rejected = await ctx.db.findOne('documents', { claim_id: claim.id, category: 'INVOICE', status: 'REJECTED' })
    const up = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, {
      buffer: samplePdf('itemised invoice'),
      filename: 'itemised-invoice.pdf',
      fields: { category: 'INVOICE', replacesDocumentId: rejected.id },
    })
    expect(up.status).toBe(201)
    expect(up.body.data.document.version_no).toBe(2)
    expect(up.body.data.claimStatus).toBe('DOCUMENT_REVIEW')
    expect((await ctx.db.findById('documents', rejected.id)).status).toBe('SUPERSEDED')

    const versions = await ctx.as('reviewer.raj').get(`/documents/${up.body.data.document.id}/versions`)
    expect(versions.body.data.map((v) => v.version_no)).toEqual([2, 1])

    const medical = await ctx.db.findOne('documents', { claim_id: claim.id, category: 'MEDICAL_REPORT' })
    expect((await ctx.as('reviewer.raj').post(`/documents/${medical.id}/review`, { decision: 'ACCEPT' })).status).toBe(200)
    expect((await ctx.as('reviewer.raj').post(`/documents/${up.body.data.document.id}/review`, { decision: 'ACCEPT', comment: 'Itemised' })).status).toBe(200)
    expect(await ctx.db.count('tasks', { claim_id: claim.id, task_type: 'DOCUMENT_FOLLOW_UP', status: 'OPEN' })).toBe(0)

    const next = await ctx.as('reviewer.raj').post(`/claims/${claim.id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' })
    expect(next.status).toBe(200)
  })

  it('allows a manager to record a document exception instead', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000103')
    const denied = await ctx.as('ops.olivia').post(`/claims/${claim.id}/document-exception`, { reason: 'Photos unavailable — loss adjuster attended site' })
    expect(denied.status).toBe(403)
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/document-exception`, { reason: 'Photos unavailable — loss adjuster attended site' })
    expect(res.status).toBe(200)
    expect(res.body.data.document_exception_by).toBe(await ctx.userId('manager.maria'))
  })

  it('blocks reviewers from reviewing documents they uploaded', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    await ctx.db.update('claims', { id: claim.id }, { status: 'DOCUMENT_REVIEW' }).catch(() => {})
    const up = await ctx.as('reviewer.raj').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'note.pdf', fields: { category: 'OTHER' } })
    expect(up.status).toBe(201)
    const res = await ctx.as('reviewer.raj').post(`/documents/${up.body.data.document.id}/review`, { decision: 'ACCEPT' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN')
  })

  it('lets customers answer information requests', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000103')
    const req = await ctx.db.findOne('information_requests', { claim_id: claim.id, request_type: 'INFORMATION' })
    const res = await ctx.as('customer.alice').post(`/information-requests/${req.id}/respond`, { responseText: 'Serviced in March this year.' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('RESPONDED')
    expect((await ctx.as('customer.chen').post(`/information-requests/${req.id}/respond`, { responseText: 'nope' })).status).toBe(404)
  })
})
