import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('status transitions', () => {
  it('rejects transitions that are not defined, listing the permitted ones', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'PAID' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('INVALID_TRANSITION')
    expect(res.body.error.message).toMatch(/cannot move from Submitted to Paid/)
    expect(res.body.error.details.allowed).toContain('POLICY_VERIFICATION')
  })

  it('rejects roles that may not execute a transition', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('reviewer.raj').post(`/claims/${claim.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })
    expect([403, 404]).toContain(res.status)
    const engineer = await ctx.as('data.dana').post(`/claims/${claim.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })
    expect(engineer.status).toBe(403)
    expect(engineer.body.error.code).toBe('TRANSITION_NOT_PERMITTED')
  })

  it('enforces guards with a clear explanation', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('WORKFLOW_GUARD_FAILED')
    expect(res.body.error.details.failures.map((f) => f.guard)).toEqual(['coverageConfirmed', 'intakeChecklistComplete'])
  })

  it('requires reasons where configured', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'ON_HOLD' })
    expect(res.status).toBe(422)
  })

  it('prevents clients from executing staff-only transitions on their own claims', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('customer.ben').post(`/claims/${claim.id}/transitions`, { toStatus: 'POLICY_VERIFICATION' })
    expect(res.status).toBe(403)
  })

  it('does not allow payment outcomes to be set manually', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000112')
    const res = await ctx.as('payments.priya').post(`/claims/${claim.id}/transitions`, { toStatus: 'PAID' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('SYSTEM_TRANSITION_ONLY')
  })

  it('completes intake: coverage check against the snapshot, checklist, then document review', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000102')
    const verify = await ctx.as('ops.olivia').post(`/claims/${claim.id}/coverage-check`, { result: 'COVERED', clauseRefs: ['LIA-2.1'] })
    expect(verify.status).toBe(200)
    expect(verify.body.data.coverage.result).toBe('COVERED')
    expect(verify.body.data.coverage.snapshot_id).toBe(claim.policy_snapshot_id)
    const items = { POLICY_ACTIVE: true, COVERAGE_CONFIRMED: true, CLAIMANT_IDENTITY: true, DUPLICATE_CHECK: true, CONTACT_VERIFIED: true }
    expect((await ctx.as('ops.olivia').patch(`/claims/${claim.id}/intake-checklist`, { items })).status).toBe(200)
    const options = await ctx.as('ops.olivia').get(`/claims/${claim.id}/transitions`)
    expect(options.body.data.find((t) => t.to === 'DOCUMENT_REVIEW').allowed).toBe(true)
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'DOCUMENT_REVIEW' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('DOCUMENT_REVIEW')
    expect(res.body.data.stage).toBe('INVESTIGATION')
    // Commercial segment SLA for document review comes from segment_config.
    expect(new Date(res.body.data.due_date).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000)
    const history = await ctx.db.findMany('claim_status_history', { where: { claim_id: claim.id }, orderBy: [['created_at', 'desc']] })
    expect(history[0]).toMatchObject({ from_status: 'POLICY_VERIFICATION', to_status: 'DOCUMENT_REVIEW' })
    const intake = await ctx.db.findOne('tasks', { claim_id: claim.id, type: 'INTAKE_REVIEW' })
    expect(intake.status).toBe('DONE')
    const clocks = await ctx.db.findMany('sla_clocks', { where: { claim_id: claim.id, clock_type: 'STAGE' }, orderBy: [['started_at', 'desc']] })
    expect(clocks[0]).toMatchObject({ stage: 'DOCUMENT_REVIEW', stopped_at: null })
  })

  it('records ambiguous coverage as needing review rather than denying it', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/coverage-check`, { result: 'NEEDS_REVIEW', notes: 'Pre-existing condition wording is ambiguous' })
    expect(res.status).toBe(200)
    expect(res.body.data.claim.coverage_result).toBe('NEEDS_REVIEW')
  })

  it('pauses the stage clock on hold and only resumes to the held status', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const before = await ctx.db.findOne('sla_clocks', { claim_id: claim.id, clock_type: 'STAGE', stopped_at: null })
    expect((await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'ON_HOLD', reason: 'Awaiting fraud check' })).status).toBe(200)
    const paused = await ctx.db.findById('sla_clocks', before.id)
    expect(paused.paused_at).toBeTruthy()
    const wrong = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'INVESTIGATION' })
    expect(wrong.status).toBe(409)
    const right = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'SUBMITTED' })
    expect(right.status).toBe(200)
    const resumed = await ctx.db.findById('sla_clocks', before.id)
    expect(resumed.paused_at).toBeNull()
    expect(resumed.stopped_at).toBeNull()
    expect(new Date(resumed.due_at).getTime()).toBeGreaterThanOrEqual(new Date(before.due_at).getTime())
    const clientHistory = await ctx.as('customer.ben').get(`/claims/${claim.id}/timeline`)
    expect(clientHistory.body.data.some((e) => /hold/i.test(e.title))).toBe(false)
  })

  it('lets only the Claims Manager close; blocking tasks prevent closure; remaining reserve is released', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000114')
    const adjuster = await ctx.as('adjuster.amara').post(`/claims/${claim.id}/transitions`, { toStatus: 'CLOSED' })
    expect(adjuster.status).toBe(403)
    const operations = await ctx.as('ops.olivia').post(`/claims/${claim.id}/transitions`, { toStatus: 'CLOSED' })
    expect(operations.status).toBe(403)
    const task = await ctx.db.insert('tasks', { claim_id: claim.id, title: 'Blocking wrap-up', blocking: true, type: 'GENERAL', owner_role: 'OPS_MANAGER' })
    const blocked = await ctx.as('manager.maria').post(`/claims/${claim.id}/transitions`, { toStatus: 'CLOSED' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toMatch(/blocking task/)
    expect((await ctx.as('manager.maria').patch(`/tasks/${task.id}`, { status: 'DONE' })).status).toBe(200)
    const ok = await ctx.as('manager.maria').post(`/claims/${claim.id}/transitions`, { toStatus: 'CLOSED' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.closed_at).toBeTruthy()
    expect(ok.body.data.stage).toBe('CLOSURE')
    const open = await ctx.db.count('closure_requests', { claim_id: claim.id, status: 'PENDING' })
    expect(open).toBe(0)
  })

  it('counts reopenings', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000115')
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/transitions`, { toStatus: 'REOPENED', reason: 'New invoice found' })
    expect(res.status).toBe(200)
    expect(res.body.data.reopen_count).toBe(1)
  })

  it('closes denied claims as a permitted outcome and cancels open work', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000116')
    await ctx.db.insert('tasks', { claim_id: claim.id, title: 'Leftover task', blocking: true, type: 'GENERAL', owner_role: 'OPS_MANAGER' })
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/transitions`, { toStatus: 'CLOSED' })
    expect(res.status).toBe(200)
    expect(await ctx.db.count('tasks', { claim_id: claim.id, status: 'OPEN' })).toBe(0)
  })

  it('backs the API with a database trigger that rejects invalid status updates', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    await expect(ctx.db.update('claims', { id: claim.id }, { status: 'PAID' })).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' })
  })

  it('escalates claims and records the reason', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/escalate`, { reason: 'Client complaint received' })
    expect(res.status).toBe(200)
    expect(res.body.data.escalation_level).toBe(1)
  })
})

describe('assignment', () => {
  it('assigns an adjuster, starts the investigation and notifies the assignee', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000105')
    const adam = await ctx.userId('adjuster.adam')
    const res = await ctx.as('manager.maria').post(`/claims/${claim.id}/assignments`, { assigneeId: adam, assignmentRole: 'ADJUSTER' })
    expect(res.status).toBe(201)
    expect(res.body.data.claim.status).toBe('INVESTIGATION')
    expect(res.body.data.claim.assigned_adjuster_id).toBe(adam)
    expect(await ctx.db.count('notifications', { recipient_id: adam, claim_id: claim.id, template: 'CLAIM_ASSIGNED', channel: 'IN_APP' })).toBe(1)
    expect((await ctx.db.findOne('tasks', { claim_id: claim.id, type: 'ASSIGN_ADJUSTER' })).status).toBe('DONE')
    const investigation = await ctx.db.findOne('tasks', { claim_id: claim.id, type: 'INVESTIGATION' })
    expect(investigation.owner_user_id).toBe(adam)
  })

  it('requires a reason to reassign and keeps the assignment history', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000105')
    const amara = await ctx.userId('adjuster.amara')
    const noReason = await ctx.as('manager.maria').post(`/claims/${claim.id}/assignments`, { assigneeId: amara, assignmentRole: 'ADJUSTER' })
    expect(noReason.status).toBe(422)
    const ok = await ctx.as('manager.maria').post(`/claims/${claim.id}/assignments`, { assigneeId: amara, assignmentRole: 'ADJUSTER', reason: 'Workload balancing' })
    expect(ok.status).toBe(201)
    const history = await ctx.as('manager.maria').get(`/claims/${claim.id}/assignments`)
    const adjusters = history.body.data.filter((a) => a.assignment_role === 'ADJUSTER')
    expect(adjusters).toHaveLength(2)
    expect(adjusters.filter((a) => a.is_active)).toHaveLength(1)
  })

  it('rejects assignees without the required role', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000104')
    const priya = await ctx.userId('payments.priya')
    const res = await ctx.as('ops.olivia').post(`/claims/${claim.id}/assignments`, { assigneeId: priya, assignmentRole: 'ADJUSTER' })
    expect(res.status).toBe(422)
  })

  it('does not let adjusters assign claims', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const amara = await ctx.userId('adjuster.amara')
    const res = await ctx.as('adjuster.adam').post(`/claims/${claim.id}/assignments`, { assigneeId: amara, assignmentRole: 'ADJUSTER', reason: 'x' })
    expect(res.status).toBe(403)
  })
})

describe('tasks (FR-X2)', () => {
  it('claims a queue task for the person who starts it', async () => {
    const claim = await ctx.claimByNumber('HPC-2026-000101')
    const queue = await ctx.db.insert('tasks', { claim_id: claim.id, title: 'Call the clinic', type: 'GENERAL', owner_role: 'CLAIMS_OPS_MANAGER' })
    expect(queue.owner_user_id).toBeNull()
    const res = await ctx.as('ops.olivia').patch(`/tasks/${queue.id}`, { status: 'IN_PROGRESS' })
    expect(res.status).toBe(200)
    expect(res.body.data.owner_user_id).toBe(await ctx.userId('ops.olivia'))
    expect(res.body.data.claimed_at).toBeTruthy()
  })

  it('needs an owner or a queue for every new task', async () => {
    const res = await ctx.as('ops.olivia').post('/tasks', { title: 'Floating task' })
    expect(res.status).toBe(422)
  })
})
