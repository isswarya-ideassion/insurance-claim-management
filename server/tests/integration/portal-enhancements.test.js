import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeIndianMobile } from '../../../shared/constants.js'
import { renewedExpiry } from '../../src/modules/policies/renewals.service.js'
import { createTestContext, completeDraft, uniqueKey } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('claim form validation', () => {
  it('refuses a loss date in the future even on a draft', async () => {
    const res = await ctx.as('customer.alice').post('/claims', completeDraft('HP-MOT-100231', { lossDate: new Date(Date.now() + 2 * 86_400_000).toISOString() }))
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body.error.details)).toMatch(/cannot be in the future/)
  })

  it('accepts Indian mobile numbers in any common format and stores them as +91 XXXXX XXXXX', async () => {
    expect(normalizeIndianMobile('098450 10101')).toBe('+91 98450 10101')
    const bad = await ctx.as('customer.alice').post('/claims', completeDraft('HP-MOT-100231', { contactPhone: '+1 555 0101' }))
    expect(bad.status).toBe(422)
    const ok = await ctx.as('customer.alice').post('/claims', completeDraft('HP-MOT-100231', { contactPhone: '91-98450-10155' }))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data.contact_phone).toBe('+91 98450 10155')
  })

  it('takes the insured name from the policy, whatever the customer sends', async () => {
    const res = await ctx.as('customer.alice').post('/claims', completeDraft('HP-MOT-100231', { insuredName: 'Someone Else' }))
    expect(res.status).toBe(201)
    expect(res.body.data.insured_name).toBe('Alice Thornton')
    const patched = await ctx.as('customer.alice').patch(`/claims/${res.body.data.id}`, { policyNumber: 'HP-MOT-100231', insuredName: 'Someone Else' })
    expect(patched.body.data.insured_name).toBe('Alice Thornton')
  })

  it('requires the loss city and country before submission', async () => {
    const draft = await ctx.as('customer.alice').post('/claims', completeDraft('HP-MOT-100231', { lossCity: null, lossCountry: null, lossDate: new Date(Date.now() - 40 * 86_400_000).toISOString() }))
    const res = await ctx.as('customer.alice').post(`/claims/${draft.body.data.id}/submit`, { submissionKey: uniqueKey() })
    expect(res.status).toBe(422)
    expect(res.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['loss_city', 'loss_country']))
  })
})

describe('policy renewal requests', () => {
  it('computes the renewed expiry from the current expiry, or from today once expired', () => {
    expect(renewedExpiry('2027-03-31', 12, new Date('2026-10-27T00:00:00Z'))).toBe('2028-03-31')
    expect(renewedExpiry('2026-01-15', 6, new Date('2026-10-27T00:00:00Z'))).toBe('2027-04-27')
  })

  it('lets a customer request renewal once, and a Claims Operations Manager complete it', async () => {
    const policy = await ctx.db.findOne('policies', { external_policy_no: 'HP-PRP-200001' })
    const req = await ctx.as('customer.alice').post(`/policies/${policy.id}/renewal-requests`, { termMonths: 12, notes: 'Please renew' })
    expect(req.status, JSON.stringify(req.body)).toBe(201)
    expect((await ctx.as('customer.alice').post(`/policies/${policy.id}/renewal-requests`, {})).body.error.code).toBe('RENEWAL_ALREADY_REQUESTED')
    expect((await ctx.as('customer.ben').post(`/policies/${policy.id}/renewal-requests`, {})).status).toBe(404)

    const task = await ctx.db.findById('tasks', req.body.data.task_id)
    expect(task).toMatchObject({ type: 'POLICY_RENEWAL', owner_role: 'CLAIMS_OPS_MANAGER', status: 'OPEN' })

    const listed = await ctx.as('customer.alice').get('/policies')
    expect(listed.body.data.find((p) => p.id === policy.id).renewal).toMatchObject({ status: 'REQUESTED' })

    expect((await ctx.as('adjuster.adam').get('/policy-renewals')).status).toBe(403)
    const queue = await ctx.as('ops.olivia').get('/policy-renewals?status=REQUESTED')
    expect(queue.body.data.find((r) => r.id === req.body.data.id)).toMatchObject({ canDecide: true, policy_number: 'HP-PRP-200001' })

    expect((await ctx.as('ops.olivia').post(`/policy-renewals/${req.body.data.id}/decision`, { decision: 'DECLINED' })).status).toBe(422)
    const done = await ctx.as('ops.olivia').post(`/policy-renewals/${req.body.data.id}/decision`, { decision: 'COMPLETED' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data.policy.status).toBe('ACTIVE')
    expect(done.body.data.policy.expiry_date > policy.expiry_date).toBe(true)
    expect((await ctx.db.findById('tasks', task.id)).status).toBe('DONE')
    const alice = await ctx.userId('customer.alice')
    expect(await ctx.db.count('notifications', { recipient_id: alice, template: 'POLICY_RENEWAL', channel: 'IN_APP' })).toBe(1)
  })
})

describe('rejection notifications and settlement queue', () => {
  it('sends a CLAIM_REJECTED notification when a claim is denied', async () => {
    const claim = await ctx.db.findOne('claims', { claim_number: 'HPC-2026-000108' })
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/transitions`, { toStatus: 'REJECTED', reason: 'Loss excluded under the policy wording.' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await ctx.db.count('notifications', { claim_id: claim.id, template: 'CLAIM_REJECTED', channel: 'IN_APP' })).toBe(1)
  })

  it('lets a Claims Manager list only settlements waiting for them', async () => {
    const all = await ctx.as('manager.maria').get('/settlements/queue')
    const mine = await ctx.as('manager.maria').get('/settlements/queue?awaitingMe=true')
    expect(mine.body.data.every((s) => s.required_role === 'OPS_MANAGER')).toBe(true)
    expect(all.body.data.some((s) => s.required_role === 'ADJUSTER')).toBe(true)
  })
})
