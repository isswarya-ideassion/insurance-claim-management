import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, completeDraft, uniqueKey } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

async function createDraft(who, body) {
  const res = await ctx.as(who).post('/claims', body)
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data
}

describe('claim submission', () => {
  it('saves partial drafts and resumes them', async () => {
    const draft = await createDraft('customer.alice', { policyNumber: 'HP-MOT-100231', draftStep: 2 })
    expect(draft.status).toBe('DRAFT')
    expect(draft.claim_number).toBeNull()
    expect(draft.claim_type).toBe('MOTOR')
    const upd = await ctx.as('customer.alice').patch(`/claims/${draft.id}`, { incidentLocation: 'Main St', draftStep: 3 })
    expect(upd.status).toBe(200)
    expect(upd.body.data.draft_step).toBe(3)
  })

  it('reports missing fields when submitting an incomplete draft', async () => {
    const draft = await createDraft('customer.alice', { policyNumber: 'HP-MOT-100231' })
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(422)
    const fields = res.body.error.details.map((d) => d.field)
    expect(fields).toEqual(expect.arrayContaining(['incident_description', 'declaration_accepted', 'contact_email']))
  })

  it('refuses policies owned by another customer', async () => {
    const res = await ctx.as('customer.alice').post('/claims', { policyNumber: 'HP-MOT-100877' })
    expect(res.status).toBe(422)
  })

  it('rejects ineligible (lapsed) policies at submission using the database record', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-PRP-200001', { incidentCategory: 'THEFT' }))
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('POLICY_NOT_ELIGIBLE')
    expect(res.body.error.message).toMatch(/LAPSED/)
  })

  it('validates incident category against the policy type', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { incidentCategory: 'SURGERY' }))
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/not covered/)
  })

  it('generates a unique reference and replays duplicate submissions idempotently', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { incidentAt: new Date(Date.now() - 50 * 86_400_000).toISOString() }))
    const key = uniqueKey()
    const first = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: key })
    expect(first.status).toBe(201)
    expect(first.body.data.claim_number).toMatch(/^HPC-\d{4}-\d{6}$/)
    expect(first.body.data.status).toBe('SUBMITTED')

    const replay = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: key })
    expect(replay.status).toBe(200)
    expect(replay.body.meta.replayed).toBe(true)
    expect(replay.body.data.claim_number).toBe(first.body.data.claim_number)

    const again = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: uniqueKey() })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_SUBMITTED')

    const intake = await ctx.db.count('tasks', { claim_id: draft.id, task_type: 'INTAKE_REVIEW' })
    expect(intake).toBe(1)
    const notes = await ctx.db.count('notifications', { claim_id: draft.id, type: 'CLAIM_SUBMITTED' })
    expect(notes).toBe(1)
  })

  it('warns about likely duplicates but allows a confirmed separate claim', async () => {
    const incidentAt = new Date(Date.now() - 20 * 86_400_000).toISOString()
    const a = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { incidentAt }))
    expect((await ctx.as('customer.alice').post(`/claims/${a.id}/submit`, {})).status).toBe(201)

    const b = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { incidentAt }))
    const blocked = await ctx.as('customer.alice').post(`/claims/${b.id}/submit`, {})
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('POSSIBLE_DUPLICATE')
    expect(blocked.body.error.details.existing[0].id).toBe(a.id)

    const confirmed = await ctx.as('customer.alice').post(`/claims/${b.id}/submit`, { confirmSeparateClaim: true })
    expect(confirmed.status).toBe(201)
    expect(confirmed.body.data.possible_duplicate_of).toBe(a.id)
  })
})

describe('claim ownership and scope', () => {
  it('hides other customers’ claims (404, not 403)', async () => {
    const chenClaim = await ctx.claimByNumber('HPC-2026-000105')
    const res = await ctx.as('customer.alice').get(`/claims/${chenClaim.id}`)
    expect(res.status).toBe(404)
    const list = await ctx.as('customer.alice').get('/claims?pageSize=100')
    expect(list.body.data.every((c) => c.view === 'customer')).toBe(true)
    expect(list.body.data.find((c) => c.id === chenClaim.id)).toBeUndefined()
  })

  it('returns a customer-safe projection that hides holds and internal fields', async () => {
    const held = await ctx.claimByNumber('HPC-2026-000109')
    const res = await ctx.as('customer.alice').get(`/claims/${held.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.claim).not.toHaveProperty('assigned_adjuster_id')
    expect(res.body.data.claim).not.toHaveProperty('intake_checklist')
    expect(res.body.data).not.toHaveProperty('complianceHold')
    expect(res.body.data.claim.status_label).toBe('Being assessed')
  })

  it('limits adjusters to claims they are assigned to', async () => {
    const amaras = await ctx.claimByNumber('HPC-2026-000107')
    const adams = await ctx.claimByNumber('HPC-2026-000106')
    expect((await ctx.as('adjuster.adam').get(`/claims/${amaras.id}`)).status).toBe(404)
    expect((await ctx.as('adjuster.adam').get(`/claims/${adams.id}`)).status).toBe(200)
  })

  it('limits payment operations to payment-stage claims', async () => {
    const early = await ctx.claimByNumber('HPC-2026-000102')
    const pay = await ctx.claimByNumber('HPC-2026-000112')
    expect((await ctx.as('payments.priya').get(`/claims/${early.id}`)).status).toBe(404)
    expect((await ctx.as('payments.priya').get(`/claims/${pay.id}`)).status).toBe(200)
  })

  it('never shows customer drafts to staff', async () => {
    const res = await ctx.as('ops.olivia').get('/claims?status=DRAFT&pageSize=100')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('gives data administrators no claim access', async () => {
    expect((await ctx.as('admin.dana').get('/claims')).status).toBe(403)
  })

  it('searches, filters, sorts and paginates the staff queue', async () => {
    const res = await ctx.as('ops.olivia').get('/claims?search=HP-LIA-500091&sort=claim_number&order=asc&pageSize=2')
    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].claim_number < res.body.data[1].claim_number).toBe(true)
    const byName = await ctx.as('ops.olivia').get('/claims?search=Okafor')
    expect(byName.body.data.every((c) => c.customer_name === 'Benjamin Okafor')).toBe(true)
    const filtered = await ctx.as('ops.olivia').get('/claims?status=RESERVE_APPROVAL&priority=URGENT')
    expect(filtered.body.data.map((c) => c.claim_number)).toEqual(['HPC-2026-000108'])
  })
})
