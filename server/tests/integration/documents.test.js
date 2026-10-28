import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, samplePdf } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('document upload validation', () => {
  it('accepts a real PDF and records a checksum, version and source', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf('ok'), filename: 'extra.pdf', fields: { docType: 'OTHER' } })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.document).toMatchObject({ version: 1, status: 'PENDING_REVIEW', mime_type: 'application/pdf', source: 'WEB' })
    expect(await ctx.db.count('document_versions', { document_id: res.body.data.document.id })).toBe(1)
  })

  it('stores file contents in PostgreSQL, write-once and integrity-checked', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const pdf = samplePdf('stored in postgres')
    const res = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: pdf, filename: 'stored.pdf', fields: { docType: 'OTHER' } })
    expect(res.status).toBe(201)
    const doc = await ctx.db.findById('documents', res.body.data.document.id)
    const [file] = await ctx.db.query('select content, size_bytes, sha256 from public.document_files where storage_key = $1', [doc.storage_key])
    expect(Buffer.from(file.content).equals(pdf)).toBe(true)
    expect(file.sha256).toBe(doc.sha256)
    await expect(ctx.db.query('update public.document_files set content = $2 where storage_key = $1', [doc.storage_key, Buffer.from('x')])).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    await expect(ctx.db.query('delete from public.document_files where storage_key = $1', [doc.storage_key])).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    const token = await ctx.login('customer.ben')
    const download = await request(ctx.app)
      .get(`/api/v1/documents/${doc.id}/download`)
      .set('authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((resp, cb) => {
        const chunks = []
        resp.on('data', (c) => chunks.push(c))
        resp.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(download.status).toBe(200)
    expect(Buffer.from(download.body).equals(pdf)).toBe(true)
  })

  it('rejects files whose content is not an allowed type even if renamed', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, {
      buffer: Buffer.from('#!/bin/sh\necho not a pdf\n'),
      filename: 'invoice.pdf',
      fields: { docType: 'INVOICE' },
    })
    expect(res.status).toBe(415)
  })

  it('rejects disallowed extensions and oversized files', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const exe = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'tool.exe', fields: { docType: 'OTHER' } })
    expect(exe.status).toBe(415)
    const big = Buffer.concat([samplePdf(), Buffer.alloc(10 * 1024 * 1024 + 10)])
    const tooBig = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: big, filename: 'big.pdf', fields: { docType: 'OTHER' } })
    expect(tooBig.status).toBe(413)
  })

  it('does not allow uploads to someone else’s claim or internal document types from clients', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('customer.alice').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'x.pdf', fields: { docType: 'OTHER' } })
    expect(res.status).toBe(404)
    const internal = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'x.pdf', fields: { docType: 'INVESTIGATION_EVIDENCE' } })
    expect(internal.status).toBe(403)
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

describe('document review and artifact requirements', () => {
  it('rejects a document: notifies the client, re-requests the artifact, creates a follow-up task and moves the claim back', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const doc = await ctx.db.findOne('documents', { claim_id: claim.id, doc_type: 'INVOICE' })
    const missingReason = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'REJECT' })
    expect(missingReason.status).toBe(422)

    const res = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'REJECT', rejectionReason: 'Invoice is not itemised' })
    expect(res.status).toBe(200)
    expect(res.body.data.claimStatus).toBe('DOCUMENTS_REQUIRED')

    const ben = await ctx.userId('customer.ben')
    expect(await ctx.db.count('notifications', { recipient_id: ben, template: 'DOCUMENT_REJECTED', claim_id: claim.id, channel: 'IN_APP' })).toBe(1)
    const requirement = await ctx.db.findOne('artifact_requirements', { claim_id: claim.id, doc_type: 'INVOICE', is_required: true })
    expect(requirement).toMatchObject({ status: 'REQUESTED', document_id: doc.id })
    expect(requirement.request_message).toMatch(/itemised/)
    expect(await ctx.db.count('tasks', { claim_id: claim.id, type: 'DOCUMENT_FOLLOW_UP', status: 'OPEN' })).toBe(1)

    const again = await ctx.as('reviewer.raj').post(`/documents/${doc.id}/review`, { decision: 'ACCEPT' })
    expect(again.status).toBe(409)
  })

  it('does not let the claim progress until required documents are accepted', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' })
    expect(res.status).toBe(422)
  })

  it('takes a replacement as a new version of the same document and auto-returns the claim to review', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const rejected = await ctx.db.findOne('documents', { claim_id: claim.id, doc_type: 'INVOICE', status: 'REJECTED' })
    const up = await ctx.as('customer.ben').upload(`/claims/${claim.id}/documents`, {
      buffer: samplePdf('itemised invoice'),
      filename: 'itemised-invoice.pdf',
      fields: { docType: 'INVOICE', replacesDocumentId: rejected.id },
    })
    expect(up.status).toBe(201)
    expect(up.body.data.document).toMatchObject({ id: rejected.id, version: 2, status: 'PENDING_REVIEW' })
    expect(up.body.data.claimStatus).toBe('DOCUMENT_REVIEW')
    const first = await ctx.db.findOne('document_versions', { document_id: rejected.id, version_no: 1 })
    expect(first.status).toBe('SUPERSEDED')
    expect((await ctx.db.findOne('artifact_requirements', { claim_id: claim.id, doc_type: 'INVOICE', is_required: true })).status).toBe('RECEIVED')

    const versions = await ctx.as('reviewer.raj').get(`/documents/${rejected.id}/versions`)
    expect(versions.body.data.map((v) => v.version_no)).toEqual([2, 1])
    const old = await ctx.as('reviewer.raj').get(`/documents/${rejected.id}/download?version=1`)
    expect(old.status).toBe(200)

    const medical = await ctx.db.findOne('documents', { claim_id: claim.id, doc_type: 'MEDICAL_REPORT' })
    expect((await ctx.as('reviewer.raj').post(`/documents/${medical.id}/review`, { decision: 'ACCEPT' })).status).toBe(200)
    expect((await ctx.as('reviewer.raj').post(`/documents/${rejected.id}/review`, { decision: 'ACCEPT', comment: 'Itemised' })).status).toBe(200)
    expect(await ctx.db.count('tasks', { claim_id: claim.id, type: 'DOCUMENT_FOLLOW_UP', status: 'OPEN' })).toBe(0)
    expect(await ctx.db.count('artifact_requirements', { claim_id: claim.id, is_required: true, status: 'ACCEPTED' })).toBe(2)

    const next = await ctx.as('reviewer.raj').post(`/claims/${claim.id}/transitions`, { toStatus: 'ADJUSTER_ASSIGNMENT' })
    expect(next.status).toBe(200)
  })

  it('lets only a Claims Manager record a document exception, which waives the outstanding artifacts', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000103')
    const denied = await ctx.as('reviewer.raj').post(`/claims/${claim.id}/document-exception`, { reason: 'Photos unavailable — loss adjuster attended site' })
    expect(denied.status).toBe(403)
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/document-exception`, { reason: 'Photos unavailable — loss adjuster attended site' })
    expect(res.status).toBe(200)
    expect(res.body.data.document_exception_by).toBe(await ctx.userId('manager.maria'))
    expect((await ctx.db.findOne('artifact_requirements', { claim_id: claim.id, doc_type: 'PHOTOS', is_required: true })).status).toBe('WAIVED')
  })

  it('blocks reviewers from reviewing documents they uploaded', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const up = await ctx.as('reviewer.raj').upload(`/claims/${claim.id}/documents`, { buffer: samplePdf(), filename: 'note.pdf', fields: { docType: 'OTHER' } })
    expect(up.status).toBe(201)
    expect(up.body.data.document.source).toBe('STAFF')
    const res = await ctx.as('reviewer.raj').post(`/documents/${up.body.data.document.id}/review`, { decision: 'ACCEPT' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN')
  })

  it('lets clients answer information requests and see what they still owe', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000103')
    const req = await ctx.db.findOne('artifact_requirements', { claim_id: claim.id, requirement_type: 'INFORMATION' })
    const mine = await ctx.as('customer.alice').get('/artifact-requests?status=REQUESTED')
    expect(mine.body.data.map((r) => r.id)).toContain(req.id)
    const res = await ctx.as('customer.alice').post(`/artifact-requests/${req.id}/respond`, { responseText: 'Serviced in March this year.' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('RECEIVED')
    expect((await ctx.as('customer.chen').post(`/artifact-requests/${req.id}/respond`, { responseText: 'nope' })).status).toBe(404)
  })

  it('lists the required-artifact checklist for a claim', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('ops.olivia').get(`/claims/${claim.id}/artifact-requirements`)
    expect(res.status).toBe(200)
    expect(res.body.data.filter((r) => r.is_required).map((r) => r.doc_type).sort()).toEqual(['INVOICE', 'MEDICAL_REPORT'])
  })
})
