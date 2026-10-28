import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('audit logging', () => {
  it('records actor, roles, request id and changed fields for mutations', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })
    expect(res.status).toBe(200)
    const entry = await ctx.db.findOne('audit_logs', { claim_id: claim.id, action: 'CLAIM_STATUS_CHANGED', request_id: res.headers['x-request-id'] })
    expect(entry.actor_id).toBe(await ctx.userId('ops.olivia'))
    expect(entry.actor_roles).toEqual(['CLAIMS_OPERATIONS'])
    expect(entry.before_data.status).toBe('SUBMITTED')
    expect(entry.after_data.status).toBe('POLICY_VERIFICATION')
  })

  it('rolls back the audit entry together with a failed change', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const before = await ctx.db.count('audit_logs', { claim_id: claim.id })
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(res.status).toBe(409)
    expect(await ctx.db.count('audit_logs', { claim_id: claim.id })).toBe(before)
  })

  it('makes audit records immutable', async () => {
    const [entry] = await ctx.db.findMany('audit_logs', { limit: 1 })
    await expect(ctx.db.update('audit_logs', { id: entry.id }, { action: 'TAMPERED' })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    await expect(ctx.db.remove('audit_logs', { id: entry.id })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
  })

  it('restricts the audit log to authorised roles', async () => {
    expect((await ctx.as('auditor.ade').get('/audit-logs?pageSize=5')).status).toBe(200)
    expect((await ctx.as('adjuster.adam').get('/audit-logs')).status).toBe(403)
    expect((await ctx.as('customer.alice').get('/audit-logs')).status).toBe(403)
  })

  it('keeps the auditor read-only across the API', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    expect((await ctx.as('auditor.ade').get(`/claims/${claim.id}`)).status).toBe(200)
    expect((await ctx.as('auditor.ade').post(`/claims/${claim.id}/notes`, { body: 'hi' })).status).toBe(403)
    expect((await ctx.as('auditor.ade').post('/tasks', { title: 'Nope task' })).status).toBe(403)
    expect((await ctx.as('auditor.ade').post(`/claims/${claim.id}/escalate`, { reason: 'Testing escalation' })).status).toBe(403)
  })
})

describe('notifications', () => {
  it('lists only the caller’s notifications and records honest email status', async () => {
    const res = await ctx.as('customer.alice').get('/notifications')
    expect(res.status).toBe(200)
    const alice = await ctx.userId('customer.alice')
    expect(res.body.data.every((n) => n.recipient_id === alice)).toBe(true)
    expect(res.body.data.every((n) => n.email_status !== 'SENT')).toBe(true)
    const other = await ctx.db.findOne('notifications', { recipient_id: await ctx.userId('customer.ben') })
    expect((await ctx.as('customer.alice').post(`/notifications/${other.id}/read`)).status).toBe(404)
    const all = await ctx.as('customer.alice').post('/notifications/read-all')
    expect(all.status).toBe(200)
    expect((await ctx.as('customer.alice').get('/notifications/unread-count')).body.data.unread).toBe(0)
  })

  it('creates overdue-task notifications once per task', async () => {
    const first = await ctx.as('admin.dana').post('/admin/jobs/overdue-sweep')
    expect(first.status).toBe(200)
    expect(first.body.data.overdue).toBeGreaterThan(0)
    const second = await ctx.as('admin.dana').post('/admin/jobs/overdue-sweep')
    expect(second.body.data.overdue).toBe(0)
    expect(await ctx.db.count('notifications', { type: 'TASK_OVERDUE' })).toBeGreaterThan(0)
  })
})

describe('reports', () => {
  it('builds reports from live data restricted to the caller’s scope', async () => {
    const ops = await ctx.as('ops.olivia').get('/reports/summary')
    expect(ops.status).toBe(200)
    const total = ops.body.data.claimsByStatus.reduce((a, r) => a + r.count, 0)
    expect(total).toBe(await ctx.db.count('claims', { status: { ne: 'DRAFT' } }))
    expect(ops.body.data.teamProductivity).not.toBeNull()

    const pay = await ctx.as('payments.priya').get('/reports/summary')
    expect(pay.body.data.scope.claims).toBeLessThan(ops.body.data.scope.claims)
    expect(pay.body.data.teamProductivity).toBeNull()
    expect((await ctx.as('customer.alice').get('/reports/summary')).status).toBe(403)
  })
})
