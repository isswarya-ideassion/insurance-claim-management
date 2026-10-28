import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INTAKE_CHECKLIST } from '../../../shared/constants.js'
import { createTestContext, completeDraft, uniqueKey } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

// Each submission uses a loss date a few days apart, so duplicate detection does not interfere.
let offsetDays = 3
async function submitNewClaim(who = 'customer.alice', policy = 'HP-MOT-100231') {
  offsetDays += 3
  const body = completeDraft(policy, { lossDate: new Date(Date.now() - offsetDays * 86_400_000).toISOString() })
  const draft = await ctx.as(who).post('/claims', body)
  expect(draft.status, JSON.stringify(draft.body)).toBe(201)
  const res = await ctx.as(who).post(`/claims/${draft.body.data.id}/submit`, { submissionKey: uniqueKey() })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return ctx.db.findById('claims', draft.body.data.id)
}

describe('intake routing to the Claims Operations Manager', () => {
  it('assigns a new claim directly to the Claims Operations Manager with the lightest workload', async () => {
    // Olivia owns most seeded claims; Omar owns one, so Omar is picked.
    const omar = await ctx.userId('ops.omar')
    const claim = await submitNewClaim()
    expect(claim.assigned_owner_id).toBe(omar)

    const assignment = await ctx.db.findOne('claim_assignments', { claim_id: claim.id, assignment_role: 'OPERATIONS_OWNER', is_active: true })
    expect(assignment).toMatchObject({ assignee_id: omar, assigned_by: null })
    expect(assignment.reason).toMatch(/lowest workload/)

    const task = await ctx.db.findOne('tasks', { claim_id: claim.id, type: 'INTAKE_REVIEW' })
    expect(task).toMatchObject({ owner_user_id: omar, owner_role: 'CLAIMS_OPS_MANAGER', blocking: true })

    const notice = await ctx.db.findOne('notifications', { recipient_id: omar, claim_id: claim.id, template: 'CLAIM_ASSIGNED', channel: 'IN_APP' })
    expect(notice).toBeTruthy()

    const audit = await ctx.db.findOne('audit_logs', { claim_id: claim.id, action: 'CLAIM_AUTO_ASSIGNED' })
    expect(audit).toMatchObject({ actor_type: 'SYSTEM', actor_id: null })
  })

  it('skips inactive managers and falls back to the role queue when nobody is available', async () => {
    const omar = await ctx.userId('ops.omar')
    const olivia = await ctx.userId('ops.olivia')
    try {
      await ctx.db.updateById('users', omar, { is_active: false })
      const toOlivia = await submitNewClaim()
      expect(toOlivia.assigned_owner_id).toBe(olivia)

      await ctx.db.updateById('users', olivia, { is_active: false })
      const queued = await submitNewClaim()
      expect(queued.assigned_owner_id).toBeNull()
      const task = await ctx.db.findOne('tasks', { claim_id: queued.id, type: 'INTAKE_REVIEW' })
      expect(task).toMatchObject({ owner_user_id: null, owner_role: 'CLAIMS_OPS_MANAGER' })
      const maria = await ctx.userId('manager.maria')
      expect(await ctx.db.findOne('notifications', { recipient_id: maria, claim_id: queued.id, channel: 'IN_APP' })).toBeTruthy()
    } finally {
      await ctx.db.updateById('users', omar, { is_active: true })
      await ctx.db.updateById('users', olivia, { is_active: true })
    }
  })

  it('keeps a claim with the Claims Operations Manager who raised it on the client’s behalf', async () => {
    const olivia = await ctx.userId('ops.olivia')
    const body = { ...completeDraft('HP-MOT-100231', { lossDate: new Date(Date.now() - 40 * 86_400_000).toISOString() }) }
    const draft = await ctx.as('ops.olivia').post('/claims', body)
    expect(draft.status, JSON.stringify(draft.body)).toBe(201)
    const res = await ctx.as('ops.olivia').post(`/claims/${draft.body.data.id}/submit`, { submissionKey: uniqueKey(), confirmSeparateClaim: true })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((await ctx.db.findById('claims', draft.body.data.id)).assigned_owner_id).toBe(olivia)
  })
})

describe('role split: Claims Operations Manager and Claims Manager', () => {
  it('gives intake to the Claims Operations Manager and decisions to the Claims Manager', async () => {
    const submitted = await ctx.claimByNumber('HPC-2026-000101')
    expect((await ctx.as('manager.maria').post(`/claims/${submitted.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })).status).toBe(403)
    expect((await ctx.as('ops.omar').post(`/claims/${submitted.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })).status).toBe(200)

    const verifying = await ctx.claimByNumber('HPC-2026-000102')
    expect((await ctx.as('manager.maria').post(`/claims/${verifying.id}/coverage-check`, { result: 'COVERED' })).status).toBe(403)
    const deny = { toStatus: 'REJECTED', reason: 'Loss is excluded by the policy wording' }
    expect((await ctx.as('ops.olivia').post(`/claims/${verifying.id}/transitions`, deny)).status).toBe(403)

    const reserve = (await ctx.as('manager.maria').get(`/claims/${(await ctx.claimByNumber('HPC-2026-000107')).id}/reserves`)).body.data.find((r) => r.approval_status === 'PENDING_REVIEW')
    expect((await ctx.as('ops.olivia').post(`/reserves/${reserve.id}/review`, { decision: 'APPROVED' })).status).toBe(403)
  })
})

describe('payee details collected and verified at intake', () => {
  it('requires a verified payee before the claim leaves intake, verified by someone else', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const before = await ctx.as('ops.olivia').get(`/claims/${claim.id}/payee`)
    expect(before.status).toBe(200)
    expect(before.body.data).toMatchObject({ canRecord: true, payee: { verification_status: 'VERIFIED' } })

    // The claimant gives a new account during intake.
    const recorded = await ctx.as('ops.olivia').put(`/claims/${claim.id}/payee`, {
      payeeName: 'Chen Wei',
      bankName: 'Harbor Community Bank (fictional)',
      accountNumber: '55667788',
      reason: 'Claimant confirmed a new account by phone',
    })
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200)
    expect(recorded.body.data).toMatchObject({ verification_status: 'UNVERIFIED', account_masked: '•••• 7788', changed_by_me: true })
    const stored = await ctx.db.findById('payees', recorded.body.data.id)
    expect(stored.bank_details_encrypted.startsWith('v1:')).toBe(true)

    // Coverage and checklist done, but the payee is not verified yet.
    expect((await ctx.as('ops.olivia').post(`/claims/${claim.id}/coverage-check`, { result: 'COVERED' })).status).toBe(200)
    const items = Object.fromEntries(INTAKE_CHECKLIST.map((i) => [i.key, true]))
    expect((await ctx.as('ops.olivia').patch(`/claims/${claim.id}/intake-checklist`, { items })).status).toBe(200)
    const blocked = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toMatch(/not yet verified/)

    // The person who entered the details cannot verify them.
    const self = await ctx.as('ops.olivia').post(`/payees/${stored.id}/verify`, {})
    expect(self.status).toBe(403)
    expect(self.body.error.code).toBe('SEPARATION_OF_DUTIES')
    expect((await ctx.as('ops.omar').get(`/claims/${claim.id}/payee`)).body.data.canVerify).toBe(true)
    expect((await ctx.as('ops.omar').post(`/payees/${stored.id}/verify`, { notes: 'Confirmed with the claimant' })).status).toBe(200)

    const routed = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(routed.status, JSON.stringify(routed.body)).toBe(200)
    expect(await ctx.db.findOne('audit_logs', { entity_id: stored.id, action: 'PAYEE_DETAILS_RECORDED' })).toBeTruthy()
  })

  it('keeps payee details away from clients and other roles', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    expect((await ctx.as('customer.chen').get(`/claims/${claim.id}/payee`)).status).toBe(403)
    expect((await ctx.as('adjuster.adam').get(`/claims/${claim.id}/payee`)).status).toBe(403)
    const body = { payeeName: 'X Y', accountNumber: '12345678', reason: 'Testing access' }
    expect((await ctx.as('manager.maria').put(`/claims/${claim.id}/payee`, body)).status).toBe(403)
    expect((await ctx.as('payments.priya').put(`/claims/${claim.id}/payee`, body)).status).toBe(403)
  })
})
