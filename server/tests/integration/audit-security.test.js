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
    expect(entry.actor_type).toBe('USER')
    expect(entry.actor_roles).toEqual(['CLAIMS_OPS_MANAGER'])
    expect(entry.before.status).toBe('SUBMITTED')
    expect(entry.after.status).toBe('POLICY_VERIFICATION')
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(entry.hash_prev).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rolls back the audit entry together with a failed change', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const before = await ctx.db.count('audit_logs', { claim_id: claim.id })
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(res.status).toBe(409)
    expect(await ctx.db.count('audit_logs', { claim_id: claim.id })).toBe(before)
  })

  it('makes audit records immutable and the hash chain verifiable', async () => {
    const [entry] = await ctx.db.findMany('audit_logs', { limit: 1 })
    await expect(ctx.db.update('audit_logs', { id: entry.id }, { action: 'TAMPERED' })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    await expect(ctx.db.remove('audit_logs', { id: entry.id })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' })
    const verify = await ctx.as('compliance.carlos').get('/audit-logs/verify')
    expect(verify.status).toBe(200)
    expect(verify.body.data).toMatchObject({ intact: true, problems: [] })
    expect((await ctx.as('manager.maria').get('/audit-logs/verify')).status).toBe(403)
  })

  it('detects tampering that bypasses the immutability trigger', async () => {
    const pg = ctx.deps.db.executor
    await pg.query(`alter table public.audit_logs disable trigger audit_logs_immutable`)
    const [row] = await ctx.db.query(`select id, occurred_at from public.audit_logs order by seq limit 1 offset 3`)
    await pg.query(`update public.audit_logs set action = 'TAMPERED' where id = $1 and occurred_at = $2`, [row.id, row.occurred_at])
    await pg.query(`alter table public.audit_logs enable trigger audit_logs_immutable`)
    const verify = await ctx.as('compliance.carlos').get('/audit-logs/verify')
    expect(verify.body.data.intact).toBe(false)
    expect(verify.body.data.problems[0]).toMatchObject({ id: row.id, problem: 'HASH_MISMATCH' })
  })

  it('scopes audit search by role (ABAC)', async () => {
    const all = await ctx.as('compliance.carlos').get('/audit-logs?pageSize=100')
    expect(all.status).toBe(200)
    const manager = await ctx.as('manager.maria').get('/audit-logs?pageSize=100')
    expect(manager.body.data.every((r) => r.claim_id)).toBe(true)
    const engineer = await ctx.as('data.dana').get('/audit-logs?pageSize=100')
    expect(engineer.body.data.every((r) => ['integration', 'system', 'job'].includes(r.entity_type))).toBe(true)
    expect((await ctx.as('adjuster.adam').get('/audit-logs')).status).toBe(403)
    expect((await ctx.as('customer.alice').get('/audit-logs')).status).toBe(403)
  })

  it('keeps Compliance & Security out of claim decisions it does not own', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    expect((await ctx.as('compliance.carlos').get(`/claims/${claim.id}`)).status).toBe(200)
    expect((await ctx.as('compliance.carlos').post(`/claims/${claim.id}/escalate`, { reason: 'Testing escalation' })).status).toBe(403)
    const doc = await ctx.db.findOne('documents', { claim_id: claim.id })
    expect((await ctx.as('compliance.carlos').post(`/documents/${doc.id}/review`, { decision: 'ACCEPT' })).status).toBe(403)
  })
})

describe('notifications', () => {
  it('lists only the caller’s in-app notifications and records honest email status', async () => {
    const res = await ctx.as('customer.alice').get('/notifications')
    expect(res.status).toBe(200)
    const alice = await ctx.userId('customer.alice')
    expect(res.body.data.every((n) => n.recipient_id === alice && n.channel === 'IN_APP')).toBe(true)
    expect(await ctx.db.count('notifications', { channel: 'EMAIL', status: 'SENT' })).toBe(0)
    const other = await ctx.db.findOne('notifications', { recipient_id: await ctx.userId('customer.ben') })
    expect((await ctx.as('customer.alice').post(`/notifications/${other.id}/read`)).status).toBe(404)
    const all = await ctx.as('customer.alice').post('/notifications/read-all')
    expect(all.status).toBe(200)
    expect((await ctx.as('customer.alice').get('/notifications/unread-count')).body.data.unread).toBe(0)
  })

  it('creates overdue-task notifications once per task and escalates breached SLA clocks', async () => {
    const first = await ctx.as('manager.maria').post('/admin/jobs/overdue-sweep')
    expect(first.status).toBe(200)
    expect(first.body.data.overdue).toBeGreaterThan(0)
    const second = await ctx.as('manager.maria').post('/admin/jobs/overdue-sweep')
    expect(second.body.data.overdue).toBe(0)
    expect(await ctx.db.count('notifications', { template: 'TASK_OVERDUE' })).toBeGreaterThan(0)
    expect(first.body.data.sla).toHaveProperty('escalated')
    expect((await ctx.as('data.dana').post('/admin/jobs/overdue-sweep')).status).toBe(403)
  })
})

describe('reports', () => {
  it('builds reports from live data restricted to the caller’s scope, with SLA KPIs', async () => {
    // Team metrics are for Claims Managers (and Compliance & Security).
    const ops = await ctx.as('manager.maria').get('/reports/summary')
    expect(ops.status).toBe(200)
    const total = ops.body.data.claimsByStatus.reduce((a, r) => a + r.count, 0)
    expect(total).toBe(await ctx.db.count('claims', { status: { ne: 'DRAFT' } }))
    expect(ops.body.data.teamProductivity).not.toBeNull()
    expect(ops.body.data.claimsByStage.length).toBeGreaterThan(0)
    expect(ops.body.data).toHaveProperty('slaAttainment')
    expect(ops.body.data).toHaveProperty('cycleTime')

    const pay = await ctx.as('payments.priya').get('/reports/summary')
    expect(pay.body.data.scope.claims).toBeLessThan(ops.body.data.scope.claims)
    expect(pay.body.data.teamProductivity).toBeNull()
    expect((await ctx.as('customer.alice').get('/reports/summary')).status).toBe(403)
  })
})

describe('configuration (four-eyes)', () => {
  it('requires a different person to approve a segment configuration change', async () => {
    const proposal = await ctx.as('manager.maria').post('/config/segments', {
      segment: 'PERSONAL',
      configKey: 'severity_thresholds',
      configValue: { MEDIUM: 6000, HIGH: 60000, CATASTROPHIC: 250000 },
      notes: 'Inflation adjustment',
    })
    expect(proposal.status).toBe(201)
    expect(proposal.body.data).toMatchObject({ status: 'PROPOSED', version: 2 })
    const self = await ctx.as('manager.maria').post(`/config/segments/${proposal.body.data.id}/decision`, { decision: 'APPROVED' })
    expect(self.status).toBe(403)
    const ok = await ctx.as('compliance.carlos').post(`/config/segments/${proposal.body.data.id}/decision`, { decision: 'APPROVED' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('ACTIVE')
    const active = await ctx.db.findMany('segment_config', { where: { segment: 'PERSONAL', config_key: 'severity_thresholds' } })
    expect(active.filter((r) => r.status === 'ACTIVE')).toHaveLength(1)
    expect(active.find((r) => r.version === 1).status).toBe('RETIRED')
  })

  it('validates configuration values before they can be proposed', async () => {
    const res = await ctx.as('manager.maria').post('/config/segments', { segment: 'PERSONAL', configKey: 'severity_thresholds', configValue: { MEDIUM: 10, HIGH: 5, CATASTROPHIC: 1 } })
    expect(res.status).toBe(422)
  })
})
