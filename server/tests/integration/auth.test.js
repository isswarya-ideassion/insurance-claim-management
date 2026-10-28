import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, PASSWORD } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('authentication', () => {
  it('reports the database and demo data on the health endpoint', async () => {
    const res = await request(ctx.app).get('/api/v1/health')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ database: 'postgres', demoData: true, simulatedPayments: true })
  })

  it('accepts bcrypt hashes imported from Supabase and upgrades them to scrypt', async () => {
    const bcrypt = (await import('bcryptjs')).default
    const email = 'imported.client@example.test'
    const reg = await request(ctx.app).post('/api/v1/auth/register').send({ email, password: 'Str0ng-Password!', fullName: 'Imported Client', acceptPrivacyNotice: true })
    expect(reg.status).toBe(201)
    // Supabase Auth stores bcrypt hashes; the import copies them unchanged.
    await ctx.db.query('update auth.users set encrypted_password = $2 where lower(email) = $1', [email, bcrypt.hashSync('Imported-Pass-123', 10)])
    const wrong = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Wrong-Pass-123' })
    expect(wrong.status).toBe(401)
    const ok = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Imported-Pass-123' })
    expect(ok.status).toBe(200)
    const [row] = await ctx.db.query('select encrypted_password from auth.users where lower(email) = $1', [email])
    expect(row.encrypted_password.startsWith('scrypt$')).toBe(true)
    const again = await request(ctx.app).post('/api/v1/auth/login').send({ email, password: 'Imported-Pass-123' })
    expect(again.status).toBe(200)
  })

  it('rejects requests without a token', async () => {
    const res = await request(ctx.app).get('/api/v1/claims')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHENTICATED')
    expect(res.body.error.requestId).toBeTruthy()
  })

  it('rejects forged tokens', async () => {
    const res = await request(ctx.app).get('/api/v1/auth/me').set('authorization', 'Bearer not-a-real-token')
    expect(res.status).toBe(401)
  })

  it('rejects wrong passwords without revealing whether the account exists', async () => {
    const wrong = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'ops.olivia@demo.harborpoint.test', password: 'nope-nope' })
    const missing = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'nobody@demo.harborpoint.test', password: 'nope-nope' })
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(wrong.body.error.message).toBe(missing.body.error.message)
  })

  it('loads roles, permissions and monetary authority by segment', async () => {
    const res = await ctx.as('manager.sam').get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.data.roles).toEqual(['OPS_MANAGER'])
    expect(res.body.data.limits.reserve).toEqual({ PERSONAL: 250000, COMMERCIAL: 250000 })
    expect(res.body.data.permissions).toEqual(expect.arrayContaining(['reserves.review', 'settlements.approve', 'claims.decideClosure']))
    const adjuster = await ctx.as('adjuster.adam').get('/auth/me')
    expect(adjuster.body.data.limits.reserve).toEqual({ PERSONAL: 15000, COMMERCIAL: 30000 })
    const client = await ctx.as('customer.alice').get('/auth/me')
    expect(client.body.data.limits).toBeNull()
  })

  it('registers clients with only the CLIENT role and records the privacy notice consent', async () => {
    const reg = await request(ctx.app).post('/api/v1/auth/register').send({
      email: 'new.client@example.test',
      password: 'Str0ng-Password!',
      fullName: 'New Client',
      roles: ['OPS_MANAGER'],
      acceptPrivacyNotice: true,
    })
    expect(reg.status).toBe(201)
    const login = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'new.client@example.test', password: 'Str0ng-Password!' })
    const token = login.body.data.accessToken
    const profile = await request(ctx.app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`)
    expect(profile.body.data.roles).toEqual(['CLIENT'])
    const consents = await request(ctx.app).get('/api/v1/auth/me/consents').set('authorization', `Bearer ${token}`)
    expect(consents.body.data.map((c) => c.consent_type)).toContain('PRIVACY_NOTICE')
  })

  it('refuses registration without accepting the privacy notice, and weak passwords', async () => {
    const noConsent = await request(ctx.app).post('/api/v1/auth/register').send({ email: 'nc@example.test', password: 'Str0ng-Password!', fullName: 'No Consent' })
    expect(noConsent.status).toBe(422)
    const weak = await request(ctx.app).post('/api/v1/auth/register').send({ email: 'weak@example.test', password: 'short', fullName: 'Weak Pw', acceptPrivacyNotice: true })
    expect(weak.status).toBe(422)
  })

  it('records channel consents and their withdrawal', async () => {
    expect((await ctx.as('customer.alice').post('/auth/me/consents', { consentType: 'CHANNEL_SMS', granted: true })).status).toBe(201)
    expect((await ctx.as('customer.alice').post('/auth/me/consents', { consentType: 'CHANNEL_SMS', granted: false })).status).toBe(201)
    const rows = await ctx.db.findMany('consents', { where: { subject_id: await ctx.userId('customer.alice'), consent_type: 'CHANNEL_SMS' } })
    expect(rows.some((r) => r.granted && r.withdrawn_at)).toBe(true)
  })

  it('does not let users change their own roles through the profile endpoint', async () => {
    const res = await ctx.as('customer.alice').patch('/auth/me', { fullName: 'Alice T.', roles: ['COMPLIANCE_SECURITY'] })
    expect(res.status).toBe(200)
    const me = await ctx.as('customer.alice').get('/auth/me')
    expect(me.body.data.roles).toEqual(['CLIENT'])
  })

  it('prevents Compliance & Security from granting themselves roles or limits', async () => {
    const carlosId = await ctx.userId('compliance.carlos')
    const res = await ctx.as('compliance.carlos').post(`/admin/users/${carlosId}/roles`, { roleCode: 'OPS_MANAGER', settlementLimit: 1e9 })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_ESCALATION_FORBIDDEN')
  })

  it('lets Compliance & Security grant roles with limits to others, and nobody else', async () => {
    const aliceId = await ctx.userId('customer.alice')
    expect((await ctx.as('manager.maria').post(`/admin/users/${aliceId}/roles`, { roleCode: 'ADJUSTER' })).status).toBe(403)
    expect((await ctx.as('data.dana').post(`/admin/users/${aliceId}/roles`, { roleCode: 'ADJUSTER' })).status).toBe(403)
    const amaraId = await ctx.userId('adjuster.amara')
    const ok = await ctx.as('compliance.carlos').put(`/admin/users/${amaraId}/attributes`, { reserveLimit: 20000 })
    expect(ok.status).toBe(200)
    const me = await ctx.as('adjuster.amara').get('/auth/me')
    expect(me.body.data.limits.reserve.PERSONAL).toBe(20000)
  })

  it('denies access to deactivated accounts', async () => {
    const benId = await ctx.userId('customer.ben')
    await ctx.login('customer.ben')
    const off = await ctx.as('compliance.carlos').patch(`/admin/users/${benId}`, { isActive: false })
    expect(off.status).toBe(200)
    const res = await ctx.as('customer.ben').get('/auth/me')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
    await ctx.as('compliance.carlos').patch(`/admin/users/${benId}`, { isActive: true })
  })

  it('supports password recovery without claiming email delivery', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/forgot-password').send({ email: 'customer.chen@demo.harborpoint.test' })
    expect(res.status).toBe(200)
    expect(res.body.data.delivery).toBe('LOGGED_DEV')
    const mail = ctx.sentEmails.find((m) => m.to === 'customer.chen@demo.harborpoint.test')
    const token = /token=([^\s]+)/.exec(mail.text)[1]
    const reset = await request(ctx.app).post('/api/v1/auth/reset-password').send({ token, password: 'New-Password-456' })
    expect(reset.status).toBe(200)
    const reuse = await request(ctx.app).post('/api/v1/auth/reset-password').send({ token, password: 'Another-Pass-789' })
    expect(reuse.status).toBe(400)
    const oldLogin = await request(ctx.app).post('/api/v1/auth/login').send({ email: 'customer.chen@demo.harborpoint.test', password: PASSWORD })
    expect(oldLogin.status).toBe(401)
  })
})
