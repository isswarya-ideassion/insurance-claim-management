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

describe('claim submission (FNOL)', () => {
  it('saves partial drafts and resumes them', async () => {
    const draft = await createDraft('customer.alice', { policyNumber: 'HP-MOT-100231', draftStep: 2 })
    expect(draft.status).toBe('DRAFT')
    expect(draft.stage).toBe('FNOL')
    expect(draft.segment).toBe('PERSONAL')
    expect(draft.claim_number).toBeNull()
    expect(draft.claim_type).toBe('MOTOR')
    const upd = await ctx.as('customer.alice').patch(`/claims/${draft.id}`, { lossLocation: 'Main St', draftStep: 3 })
    expect(upd.status).toBe(200)
    expect(upd.body.data.draft_step).toBe(3)
  })

  it('rejects edits made against a stale version (optimistic locking)', async () => {
    const draft = await createDraft('customer.alice', { policyNumber: 'HP-MOT-100231' })
    expect((await ctx.as('customer.alice').patch(`/claims/${draft.id}`, { lossLocation: 'A', version: draft.version })).status).toBe(200)
    const stale = await ctx.as('customer.alice').patch(`/claims/${draft.id}`, { lossLocation: 'B', version: draft.version })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('VERSION_CONFLICT')
  })

  it('stores claimant contact details encrypted and returns them decrypted to the owner', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { contactPhone: '9845010199' }))
    expect(draft.contact_phone).toBe('+91 98450 10199')
    const [party] = await ctx.db.query(`select contact_encrypted from public.claim_parties where claim_id = $1`, [draft.id])
    expect(party.contact_encrypted).toMatch(/^v1:/)
    expect(party.contact_encrypted).not.toContain('0199')
  })

  it('reports missing fields when submitting an incomplete draft', async () => {
    const draft = await createDraft('customer.alice', { policyNumber: 'HP-MOT-100231' })
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(422)
    const fields = res.body.error.details.map((d) => d.field)
    expect(fields).toEqual(expect.arrayContaining(['loss_description', 'declaration_accepted', 'contact_email']))
  })

  it('refuses policies owned by another client', async () => {
    const res = await ctx.as('customer.alice').post('/claims', { policyNumber: 'HP-MOT-100877' })
    expect(res.status).toBe(422)
  })

  it('rejects ineligible (lapsed) policies at submission', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-PRP-200001', { lossType: 'THEFT' }))
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('POLICY_NOT_ELIGIBLE')
    expect(res.body.error.message).toMatch(/LAPSED/)
  })

  it('validates the loss type against the policy type', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { lossType: 'SURGERY' }))
    const res = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/not covered/)
  })

  it('submits idempotently and records snapshot, required artifacts, consent and acknowledgement', async () => {
    const draft = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { lossDate: new Date(Date.now() - 50 * 86_400_000).toISOString() }))
    const key = uniqueKey()
    const first = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: key })
    expect(first.status).toBe(201)
    const claim = first.body.data
    expect(claim.claim_number).toMatch(/^HPC-\d{4}-\d{6}$/)
    expect(claim.status).toBe('SUBMITTED')
    expect(claim.severity).toBe('LOW')
    expect(claim.policy_snapshot_id).toBeTruthy()

    const replay = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: key })
    expect(replay.status).toBe(200)
    expect(replay.body.meta.replayed).toBe(true)
    expect(replay.body.data.claim_number).toBe(claim.claim_number)

    const again = await ctx.as('customer.alice').post(`/claims/${draft.id}/submit`, { submissionKey: uniqueKey() })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('ALREADY_SUBMITTED')

    const snapshot = await ctx.db.findById('policy_snapshots', claim.policy_snapshot_id)
    expect(snapshot.snapshot.external_policy_no).toBe('HP-MOT-100231')
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
    const required = await ctx.db.findMany('artifact_requirements', { where: { claim_id: draft.id, is_required: true } })
    expect(required.map((r) => r.doc_type).sort()).toEqual(['PHOTOS', 'PROOF_OF_LOSS', 'REPAIR_ESTIMATE'])
    expect(await ctx.db.count('consents', { claim_id: draft.id, consent_type: 'CLAIM_DECLARATION' })).toBe(1)
    expect(await ctx.db.count('sla_clocks', { claim_id: draft.id, clock_type: 'ACKNOWLEDGE' })).toBe(1)
    const stage = await ctx.db.findOne('sla_clocks', { claim_id: draft.id, clock_type: 'STAGE', stopped_at: null })
    expect(stage.stage).toBe('SUBMITTED')
    expect(await ctx.db.count('tasks', { claim_id: draft.id, type: 'INTAKE_REVIEW' })).toBe(1)
    expect(await ctx.db.count('notifications', { claim_id: draft.id, template: 'CLAIM_SUBMITTED', channel: 'IN_APP' })).toBe(1)
  })

  it('warns about likely duplicates but allows a confirmed separate claim', async () => {
    const lossDate = new Date(Date.now() - 20 * 86_400_000).toISOString()
    const a = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { lossDate }))
    expect((await ctx.as('customer.alice').post(`/claims/${a.id}/submit`, {})).status).toBe(201)

    const b = await createDraft('customer.alice', completeDraft('HP-MOT-100231', { lossDate }))
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
  it('hides other clients’ claims (404, not 403)', async () => {
    const chenClaim = await ctx.claimByNumber('HPC-2026-000105')
    const res = await ctx.as('customer.alice').get(`/claims/${chenClaim.id}`)
    expect(res.status).toBe(404)
    const list = await ctx.as('customer.alice').get('/claims?pageSize=100')
    expect(list.body.data.every((c) => c.view === 'customer')).toBe(true)
    expect(list.body.data.find((c) => c.id === chenClaim.id)).toBeUndefined()
  })

  it('returns a client-safe projection that hides holds, scores and internal fields', async () => {
    const held = await ctx.claimByNumber('HPC-2026-000109')
    const res = await ctx.as('customer.alice').get(`/claims/${held.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.claim).not.toHaveProperty('assigned_adjuster_id')
    expect(res.body.data.claim).not.toHaveProperty('intake_checklist')
    expect(res.body.data.claim).not.toHaveProperty('fraud_score')
    expect(res.body.data).not.toHaveProperty('complianceHold')
    expect(res.body.data.claim.status_label).toBe('Being assessed')
  })

  it('shows the fraud score to managers but only the band to adjusters', async () => {
    const held = await ctx.claimByNumber('HPC-2026-000109')
    const manager = await ctx.as('manager.maria').get(`/claims/${held.id}`)
    expect(manager.body.data.claim.fraud_score).toBe(60)
    const adjuster = await ctx.as('adjuster.amara').get(`/claims/${held.id}`)
    expect(adjuster.body.data.claim).not.toHaveProperty('fraud_score')
    expect(adjuster.body.data.claim.fraud_band).toBe('HIGH')
  })

  it('limits adjusters to claims they are assigned to', async () => {
    const amaras = await ctx.claimByNumber('HPC-2026-000107')
    const adams = await ctx.claimByNumber('HPC-2026-000106')
    expect((await ctx.as('adjuster.adam').get(`/claims/${amaras.id}`)).status).toBe(404)
    expect((await ctx.as('adjuster.adam').get(`/claims/${adams.id}`)).status).toBe(200)
  })

  it('limits payment operators to settlement and payment-stage claims', async () => {
    const early = await ctx.claimByNumber('HPC-2026-000102')
    const pay = await ctx.claimByNumber('HPC-2026-000112')
    expect((await ctx.as('payments.priya').get(`/claims/${early.id}`)).status).toBe(404)
    expect((await ctx.as('payments.priya').get(`/claims/${pay.id}`)).status).toBe(200)
  })

  it('never shows client drafts to staff', async () => {
    const res = await ctx.as('ops.olivia').get('/claims?status=DRAFT&pageSize=100')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('gives data engineers claim headers only (no contact data, no documents)', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const detail = await ctx.as('data.dana').get(`/claims/${claim.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.claim.contact_email).toBeUndefined()
    expect((await ctx.as('data.dana').get(`/claims/${claim.id}/documents`)).status).toBe(403)
  })

  it('searches, filters by stage, sorts and paginates the staff queue', async () => {
    const res = await ctx.as('ops.olivia').get('/claims?search=HP-LIA-500091&sort=claim_number&order=asc&pageSize=2')
    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBeGreaterThanOrEqual(3)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].claim_number < res.body.data[1].claim_number).toBe(true)
    const byName = await ctx.as('ops.olivia').get('/claims?search=Okafor')
    expect(byName.body.data.every((c) => c.customer_name === 'Benjamin Okafor')).toBe(true)
    const filtered = await ctx.as('ops.olivia').get('/claims?status=RESERVE_APPROVAL&priority=URGENT')
    expect(filtered.body.data.map((c) => c.claim_number)).toEqual(['HPC-2026-000108'])
    const byStage = await ctx.as('ops.olivia').get('/claims?stage=RESERVE&pageSize=50')
    expect(byStage.body.data.every((c) => c.stage === 'RESERVE')).toBe(true)
    const commercial = await ctx.as('ops.olivia').get('/claims?segment=COMMERCIAL&pageSize=50')
    expect(commercial.body.data.every((c) => c.segment === 'COMMERCIAL')).toBe(true)
  })
})
