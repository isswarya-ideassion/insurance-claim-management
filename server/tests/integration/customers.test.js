import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

// Centralized customer records belong to Compliance & Security (PRD section 2A).
const records = () => ctx.as('compliance.carlos')

describe('centralized customer records', () => {
  it('lists every client (and only clients)', async () => {
    const res = await records().get('/customers?pageSize=50')
    expect(res.status).toBe(200)
    const emails = res.body.data.map((c) => c.email)
    expect(emails).toEqual(expect.arrayContaining(['customer.alice@demo.harborpoint.test', 'customer.ben@demo.harborpoint.test', 'customer.chen@demo.harborpoint.test']))
    expect(emails.some((e) => e.startsWith('ops.'))).toBe(false)
    expect(res.body.meta.retentionYears).toBe(7)
    const alice = res.body.data.find((c) => c.email.startsWith('customer.alice'))
    expect(alice.policy_count).toBeGreaterThan(0)
    expect(alice.claim_count).toBeGreaterThan(0)
    expect(alice.retain_until).toBeTruthy()
    expect(alice).not.toHaveProperty('phone_digits')
  })

  it('searches by name, customer ID, phone and policy number', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const byName = await records().get('/customers?search=thornton')
    const byId = await records().get(`/customers?search=${aliceId.slice(0, 8)}`)
    const byPhone = await records().get('/customers?search=98450%2010101')
    const byPolicy = await records().get('/customers?search=HP-MOT-100231')
    for (const res of [byName, byId, byPhone, byPolicy]) {
      expect(res.status).toBe(200)
      expect(res.body.data.map((c) => c.id)).toEqual([aliceId])
    }
  })

  it('filters, sorts and paginates', async () => {
    const health = await records().get('/customers?policyType=HEALTH')
    expect(health.body.data.map((c) => c.email)).toEqual(['customer.ben@demo.harborpoint.test'])
    const page = await records().get('/customers?pageSize=1&page=2&sort=claim_count&direction=desc')
    expect(page.body.data).toHaveLength(1)
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 3 })
    const invalid = await records().get('/customers?sort=password')
    expect(invalid.status).toBe(422)
  })

  it('returns policies, claim history, documents and consents, masks accounts and audits the view', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const res = await records().get(`/customers/${aliceId}`)
    expect(res.status).toBe(200)
    const { customer, policies, claims, documents, retention, consents } = res.body.data
    expect(customer.email).toBe('customer.alice@demo.harborpoint.test')
    expect(policies.length).toBeGreaterThan(0)
    expect(policies[0]).not.toHaveProperty('bank_last4')
    expect(policies[0].payout_account_masked).toMatch(/^•••• \d{4}$/)
    expect(claims.every((c) => c.status !== 'DRAFT')).toBe(true)
    expect(documents.length).toBeGreaterThan(0)
    expect(documents.some((d) => d.doc_type.endsWith('_EVIDENCE'))).toBe(false)
    expect(retention.years).toBe(7)
    expect(consents.map((c) => c.consent_type)).toEqual(expect.arrayContaining(['PRIVACY_NOTICE', 'CLAIM_DECLARATION']))
    const audit = await ctx.db.findOne('audit_logs', { action: 'CUSTOMER_RECORD_VIEWED', entity_id: aliceId })
    expect(audit).toBeTruthy()
  })

  it('downloads a client document through the records module, but not another client’s', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const benId = await ctx.userId('customer.ben')
    const detail = await records().get(`/customers/${aliceId}`)
    const doc = detail.body.data.documents[0]
    const ok = await records().get(`/customers/${aliceId}/documents/${doc.id}/download`)
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toContain('no-store')
    const wrongOwner = await records().get(`/customers/${benId}/documents/${doc.id}/download`)
    expect(wrongOwner.status).toBe(404)
  })

  it('exports CSV, neutralizes formulas and audits the export', async () => {
    const aliceId = await ctx.userId('customer.alice')
    await ctx.db.updateById('users', aliceId, { full_name: '=HYPERLINK("x")' })
    const res = await records().get('/customers/export?search=demo')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.text.split('\n')[0]).toContain('Customer ID')
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`)
    expect(await ctx.db.findOne('audit_logs', { action: 'CUSTOMER_RECORDS_EXPORTED' })).toBeTruthy()
    await ctx.db.updateById('users', aliceId, { full_name: 'Alice Thornton' })
  })

  it('flags possible duplicates on shared phone numbers without blocking them', async () => {
    const benId = await ctx.userId('customer.ben')
    const chenId = await ctx.userId('customer.chen')
    const before = await ctx.db.findById('users', chenId)
    await ctx.db.updateById('users', chenId, { phone: '+91 (98450) 10102' })
    const list = await records().get('/customers?possibleDuplicate=true')
    expect(list.body.data.map((c) => c.id).sort()).toEqual([benId, chenId].sort())
    const detail = await records().get(`/customers/${benId}`)
    expect(detail.body.data.possibleDuplicates).toEqual([expect.objectContaining({ id: chenId, reason: 'Same phone number' })])
    await ctx.db.updateById('users', chenId, { phone: before.phone })
  })

  it('denies every other role', async () => {
    const aliceId = await ctx.userId('customer.alice')
    for (const who of ['data.dana', 'ops.olivia', 'manager.maria', 'adjuster.adam', 'reviewer.raj', 'payments.priya', 'customer.alice']) {
      const api = ctx.as(who)
      expect((await api.get('/customers')).status, who).toBe(403)
      expect((await api.get(`/customers/${aliceId}`)).status, who).toBe(403)
      expect((await api.get('/customers/export')).status, who).toBe(403)
    }
  })
})
