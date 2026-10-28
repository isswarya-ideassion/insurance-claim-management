import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext, PASSWORD } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('authentication', () => {
  it('reports mock mode on the health endpoint', async () => {
    const res = await request(ctx.app).get('/api/v1/health')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ mode: 'mock', mockMode: true, simulatedPayments: true })
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
    const wrong = await request(ctx.app).post('/api/v1/auth/mock/login').send({ email: 'ops.olivia@demo.harborpoint.test', password: 'nope-nope' })
    const missing = await request(ctx.app).post('/api/v1/auth/mock/login').send({ email: 'nobody@demo.harborpoint.test', password: 'nope-nope' })
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    expect(wrong.body.error.message).toBe(missing.body.error.message)
  })

  it('loads profile, roles and permissions for multi-role users', async () => {
    const res = await ctx.as('manager.sam').get('/auth/me')
    expect(res.status).toBe(200)
    expect(res.body.data.roles.sort()).toEqual(['CLAIMS_MANAGER', 'CLAIMS_OPERATIONS'])
    expect(res.body.data.approvalLimit).toBe(250000)
    expect(res.body.data.permissions).toContain('settlements.decide')
    expect(res.body.data.permissions).toContain('claims.verifyPolicy')
  })

  it('registers customers with only the CUSTOMER role', async () => {
    const reg = await request(ctx.app).post('/api/v1/auth/mock/register').send({
      email: 'new.customer@example.test',
      password: 'Str0ng-Password!',
      fullName: 'New Customer',
      roles: ['CLAIMS_MANAGER'],
    })
    expect(reg.status).toBe(201)
    const login = await request(ctx.app).post('/api/v1/auth/mock/login').send({ email: 'new.customer@example.test', password: 'Str0ng-Password!' })
    const profile = await request(ctx.app).get('/api/v1/auth/me').set('authorization', `Bearer ${login.body.data.accessToken}`)
    expect(profile.body.data.roles).toEqual(['CUSTOMER'])
  })

  it('enforces password strength on registration', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/mock/register').send({ email: 'weak@example.test', password: 'short', fullName: 'Weak Pw' })
    expect(res.status).toBe(422)
  })

  it('does not let users change their own roles through the profile endpoint', async () => {
    const res = await ctx.as('customer.alice').patch('/auth/me', { fullName: 'Alice T.', roles: ['DATA_ADMIN'] })
    expect(res.status).toBe(200)
    const me = await ctx.as('customer.alice').get('/auth/me')
    expect(me.body.data.roles).toEqual(['CUSTOMER'])
  })

  it('prevents administrators from granting themselves roles', async () => {
    const danaId = await ctx.userId('admin.dana')
    const res = await ctx.as('admin.dana').post(`/admin/users/${danaId}/roles`, { roleCode: 'CLAIMS_MANAGER', approvalLimit: 1e9 })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SELF_ESCALATION_FORBIDDEN')
  })

  it('blocks non-admins from role administration', async () => {
    const aliceId = await ctx.userId('customer.alice')
    const res = await ctx.as('manager.maria').post(`/admin/users/${aliceId}/roles`, { roleCode: 'AUDITOR' })
    expect(res.status).toBe(403)
  })

  it('denies access to deactivated accounts', async () => {
    const benId = await ctx.userId('customer.ben')
    await ctx.login('customer.ben')
    const off = await ctx.as('admin.dana').patch(`/admin/users/${benId}`, { isActive: false })
    expect(off.status).toBe(200)
    const res = await ctx.as('customer.ben').get('/auth/me')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED')
    await ctx.as('admin.dana').patch(`/admin/users/${benId}`, { isActive: true })
  })

  it('supports password recovery without claiming email delivery', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/mock/forgot-password').send({ email: 'customer.chen@demo.harborpoint.test' })
    expect(res.status).toBe(200)
    expect(res.body.data.delivery).toBe('LOGGED_DEV')
    const mail = ctx.sentEmails.find((m) => m.to === 'customer.chen@demo.harborpoint.test')
    const token = /token=([^\s]+)/.exec(mail.text)[1]
    const reset = await request(ctx.app).post('/api/v1/auth/mock/reset-password').send({ token, password: 'New-Password-456' })
    expect(reset.status).toBe(200)
    const reuse = await request(ctx.app).post('/api/v1/auth/mock/reset-password').send({ token, password: 'Another-Pass-789' })
    expect(reuse.status).toBe(400)
    const oldLogin = await request(ctx.app).post('/api/v1/auth/mock/login').send({ email: 'customer.chen@demo.harborpoint.test', password: PASSWORD })
    expect(oldLogin.status).toBe(401)
  })
})
