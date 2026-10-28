import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
let pg
beforeAll(async () => {
  ctx = await createTestContext()
  pg = ctx.deps.db.executor.raw
})
afterAll(() => ctx.close())

const records = () => ctx.as('records.rosa')

describe('centralized customer records', () => {
  it('lists every customer (and only customers) for the records admin', async () => {
    const res = await (await records()).get('/customers?pageSize=50')
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
    const api = await records()
    const aliceId = await ctx.userId('customer.alice')
    const byName = await api.get('/customers?search=thornton')
    const byId = await api.get(`/customers?search=${aliceId.slice(0, 8)}`)
    const byPhone = await api.get('/customers?search=555%200101')
    const byPolicy = await api.get('/customers?search=HP-MOT-100231')
    for (const res of [byName, byId, byPhone, byPolicy]) {
      expect(res.status).toBe(200)
      expect(res.body.data.map((c) => c.id)).toEqual([aliceId])
    }
  })

  it('filters, sorts and paginates', async () => {
    const api = await records()
    const health = await api.get('/customers?policyType=HEALTH')
    expect(health.body.data.map((c) => c.email)).toEqual(['customer.ben@demo.harborpoint.test'])
    const page = await api.get('/customers?pageSize=1&page=2&sort=claim_count&direction=desc')
    expect(page.body.data).toHaveLength(1)
    expect(page.body.meta).toMatchObject({ page: 2, pageSize: 1, total: 3 })
    const invalid = await api.get('/customers?sort=password')
    expect(invalid.status).toBe(422)
  })

  it('returns policies, claim history and documents, masks accounts and audits the view', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const res = await (await records()).get(`/customers/${aliceId}`)
    expect(res.status).toBe(200)
    const { customer, policies, claims, documents, retention } = res.body.data
    expect(customer.email).toBe('customer.alice@demo.harborpoint.test')
    expect(policies.length).toBeGreaterThan(0)
    expect(policies[0]).not.toHaveProperty('payout_account_number')
    expect(policies[0].payout_account_masked).toMatch(/^•••• \d{4}$/)
    expect(claims.every((c) => c.status !== 'DRAFT')).toBe(true)
    expect(documents.length).toBeGreaterThan(0)
    expect(documents.some((d) => d.category.endsWith('_EVIDENCE'))).toBe(false)
    expect(retention.years).toBe(7)
    const audit = await ctx.db.findOne('audit_logs', { action: 'CUSTOMER_RECORD_VIEWED', entity_id: aliceId })
    expect(audit).toBeTruthy()
  })

  it('downloads a customer document through the records module, but not another customer’s', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const benId = await ctx.userId('customer.ben')
    const detail = await (await records()).get(`/customers/${aliceId}`)
    const doc = detail.body.data.documents[0]
    const ok = await (await records()).get(`/customers/${aliceId}/documents/${doc.id}/download`)
    expect(ok.status).toBe(200)
    expect(ok.headers['cache-control']).toContain('no-store')
    const wrongOwner = await (await records()).get(`/customers/${benId}/documents/${doc.id}/download`)
    expect(wrongOwner.status).toBe(404)
  })

  it('exports CSV for the authorized role, neutralizes formulas and audits the export', async () => {
    const aliceId = await ctx.userId('customer.alice')
    await ctx.db.updateById('profiles', aliceId, { full_name: '=HYPERLINK("x")' })
    const res = await (await records()).get('/customers/export?search=demo')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.text.split('\n')[0]).toContain('Customer ID')
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`)
    expect(await ctx.db.findOne('audit_logs', { action: 'CUSTOMER_RECORDS_EXPORTED' })).toBeTruthy()
    await ctx.db.updateById('profiles', aliceId, { full_name: 'Alice Thornton' })
  })

  it('flags possible duplicates on shared phone numbers without blocking them', async () => {
    const benId = await ctx.userId('customer.ben')
    const chenId = await ctx.userId('customer.chen')
    const before = await ctx.db.findById('profiles', chenId)
    await ctx.db.updateById('profiles', chenId, { phone: '+1 (555) 0102' })
    const list = await (await records()).get('/customers?possibleDuplicate=true')
    expect(list.body.data.map((c) => c.id).sort()).toEqual([benId, chenId].sort())
    const detail = await (await records()).get(`/customers/${benId}`)
    expect(detail.body.data.possibleDuplicates).toEqual([expect.objectContaining({ id: chenId, reason: 'Same phone number' })])
    await ctx.db.updateById('profiles', chenId, { phone: before.phone })
  })

  it('denies every other role, including administrators and auditors', async () => {
    const aliceId = await ctx.userId('customer.alice')
    for (const who of ['admin.dana', 'auditor.ade', 'ops.olivia', 'manager.maria', 'compliance.carlos', 'customer.alice']) {
      const api = ctx.as(who)
      expect((await api.get('/customers')).status, who).toBe(403)
      expect((await api.get(`/customers/${aliceId}`)).status, who).toBe(403)
      expect((await api.get('/customers/export')).status, who).toBe(403)
    }
  })

  it('gives the records admin no claim workflow access', async () => {
    const api = await records()
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    expect((await api.get('/claims')).status).toBe(403)
    expect((await api.get(`/claims/${claim.id}`)).status).toBe(404)
    expect((await api.post(`/claims/${claim.id}/notes`, { body: 'note', visibility: 'INTERNAL' })).status).not.toBe(201)
  })
})

describe('customer records row-level security', () => {
  async function asUser(userId, sql, params = []) {
    return pg.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
      await tx.query('set local role authenticated')
      return (await tx.query(sql, params)).rows
    })
  }

  it('lets the records admin read policies, submitted claims and customer documents', async () => {
    const rosa = await ctx.userId('records.rosa')
    const [{ count: policies }] = await asUser(rosa, 'select count(*)::int as count from public.policies')
    const [{ count: drafts }] = await asUser(rosa, `select count(*)::int as count from public.claims where status = 'DRAFT'`)
    const [{ count: claims }] = await asUser(rosa, 'select count(*)::int as count from public.claims')
    const [{ count: evidence }] = await asUser(rosa, `select count(*)::int as count from public.documents where category like '%_EVIDENCE'`)
    expect(policies).toBeGreaterThan(0)
    expect(claims).toBeGreaterThan(0)
    expect(drafts).toBe(0)
    expect(evidence).toBe(0)
  })

  it('keeps notes, tasks, financial and audit tables closed to the records admin', async () => {
    const rosa = await ctx.userId('records.rosa')
    for (const table of ['claim_notes', 'tasks', 'reserves', 'settlements', 'payments', 'compliance_reviews', 'audit_logs', 'ai_runs']) {
      const [{ count }] = await asUser(rosa, `select count(*)::int as count from public.${table}`)
      expect(count, table).toBe(0)
    }
  })

  it('does not let the data administrator read claims', async () => {
    const dana = await ctx.userId('admin.dana')
    const [{ count }] = await asUser(dana, 'select count(*)::int as count from public.claims')
    expect(count).toBe(0)
  })
})
