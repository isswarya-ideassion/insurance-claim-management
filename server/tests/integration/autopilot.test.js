import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createTestContext, PASSWORD } from '../helpers.js'
import { createAiProvider } from '../../src/services/ai.service.js'
import { AUTO_REJECT_REASON, runScheduledAutopilot } from '../../src/modules/automation/autopilot.service.js'
import { AUTOPILOT_ACTIONS, BEACON_AUTOPILOT_USER_ID } from '../../../shared/constants.js'

let ctx
let disabledProvider
beforeAll(async () => {
  ctx = await createTestContext()
  disabledProvider = ctx.deps.ai
})
afterAll(() => ctx.close())
afterEach(() => {
  ctx.deps.ai = disabledProvider
})

const useBeacon = () => {
  ctx.deps.ai = createAiProvider({ AI_PROVIDER: 'beacon' })
}

describe('Beacon AI Auto-Pilot: access', () => {
  it('shows metrics to staff, lets operations leads sweep and managers switch it', async () => {
    expect((await ctx.as('customer.alice').get('/automation/autopilot/summary')).status).toBe(403)
    expect((await ctx.as('adjuster.adam').get('/automation/autopilot/summary')).status).toBe(200)
    expect((await ctx.as('adjuster.adam').post('/automation/autopilot/run')).status).toBe(403)
    expect((await ctx.as('reviewer.raj').put('/automation/autopilot/state', { enabled: true })).status).toBe(403)
    expect((await ctx.as('manager.maria').put('/automation/autopilot/state', { enabled: 'yes' })).status).toBe(422)
  })

  it('needs the local Beacon provider and the switch to be on', async () => {
    const noProvider = await ctx.as('ops.olivia').post('/automation/autopilot/run')
    expect(noProvider.status).toBe(409)
    expect(noProvider.body.error.code).toBe('AUTOPILOT_UNAVAILABLE')

    useBeacon()
    const off = await ctx.as('ops.olivia').post('/automation/autopilot/run')
    expect(off.status).toBe(409)
    expect(off.body.error.code).toBe('AUTOPILOT_DISABLED')
    expect(await runScheduledAutopilot(ctx.deps)).toEqual({ ran: false, reason: 'DISABLED' })
  })

  it('cannot be signed in to: the service account is inactive and has no roles', async () => {
    const account = await ctx.db.findById('users', BEACON_AUTOPILOT_USER_ID)
    expect(account).toMatchObject({ full_name: 'Beacon AI Auto-Pilot', is_active: false })
    expect(await ctx.db.count('user_roles', { user_id: BEACON_AUTOPILOT_USER_ID })).toBe(0)
    const res = await request(ctx.app).post('/api/auth/login').send({ email: account.email, password: PASSWORD })
    expect(res.status).not.toBe(200)
  })
})

describe('Beacon AI Auto-Pilot: sweep', () => {
  let sweep
  beforeAll(async () => {
    ctx.deps.ai = createAiProvider({ AI_PROVIDER: 'beacon' })
    const on = await ctx.as('manager.maria').put('/automation/autopilot/state', { enabled: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body.data.enabled).toBe(true)
    const res = await ctx.as('ops.olivia').post('/automation/autopilot/run')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    sweep = res.body.data
  })
  afterAll(() => {
    ctx.deps.ai = disabledProvider
  })

  it('runs and reports what it automated and escalated', () => {
    expect(sweep.ran).toBe(true)
    expect(sweep.automated + sweep.escalated).toBe(sweep.actions.length)
    expect(sweep.automated + sweep.escalated).toBeGreaterThan(0)
  })

  it('audits every action under the AGENT actor, in the same place as the metrics', async () => {
    const actions = await ctx.db.findMany('autopilot_actions', { where: { sweep_id: sweep.sweepId } })
    expect(actions.length).toBe(sweep.actions.length)
    for (const a of actions) {
      const audit = await ctx.db.query(
        `select actor_type, actor_id, metadata from public.audit_logs where action = $1 and claim_id = $2 and metadata ->> 'sweepId' = $3`,
        [a.action, a.claim_id, sweep.sweepId],
      )
      expect(audit.length, a.action).toBeGreaterThan(0)
      expect(audit[0]).toMatchObject({ actor_type: 'AGENT', actor_id: BEACON_AUTOPILOT_USER_ID })
      expect(a.minutes_saved).toBe(AUTOPILOT_ACTIONS[a.action].minutes)
    }
  })

  it('never approves, pays, holds, flags fraud or denies', async () => {
    const id = BEACON_AUTOPILOT_USER_ID
    expect(await ctx.db.count('settlement_approval_steps', { approver_id: id })).toBe(0)
    expect(await ctx.db.count('payment_attempts', { initiated_by: id })).toBe(0)
    expect(await ctx.db.count('claim_fraud_flags', { created_by: id })).toBe(0)
    expect(await ctx.db.count('reviews', { created_by: id, hold_active: true })).toBe(0)
    expect(await ctx.db.count('claim_status_history', { changed_by: id, to_status: { in: ['REJECTED', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAID', 'CLOSED'] } })).toBe(0)
    expect(await ctx.db.count('payees', { verified_by: id })).toBe(0)
    expect(await ctx.db.count('reserves', { set_by: id })).toBe(0)
  })

  it('rejects unnecessary documents with the fixed reason and keeps escalated ones for people, first in the queue', async () => {
    const rejected = await ctx.db.findMany('documents', { where: { reviewed_by: BEACON_AUTOPILOT_USER_ID, status: 'REJECTED' } })
    for (const d of rejected) expect(d.rejection_reason).toBe(AUTO_REJECT_REASON)
    const escalated = await ctx.db.findMany('documents', { where: { ai_escalated_at: { ne: null } } })
    for (const d of escalated) expect(d.status).toBe('PENDING_REVIEW')
    if (escalated.length) {
      const queue = await ctx.as('reviewer.raj').get('/documents/review-queue?status=PENDING_REVIEW&pageSize=50')
      if (queue.status === 200 && queue.body.data.length) expect(queue.body.data[0].ai_escalated_at).toBeTruthy()
    }
  })

  it('does not raise the same escalation twice', async () => {
    const before = await ctx.db.count('autopilot_actions', { outcome: 'ESCALATED' })
    const again = await ctx.as('manager.maria').post('/automation/autopilot/run')
    expect(again.status).toBe(200)
    expect(again.body.data.escalated).toBe(0)
    expect(await ctx.db.count('autopilot_actions', { outcome: 'ESCALATED' })).toBe(before)
  })

  it('serves live metrics that match the action log', async () => {
    const res = await ctx.as('reviewer.raj').get('/automation/autopilot/summary')
    expect(res.status).toBe(200)
    const automated = await ctx.db.count('autopilot_actions', { outcome: 'AUTOMATED' })
    const { totals } = res.body.data
    expect(totals.routineTasksAutomated).toBe(automated)
    expect(totals.escalated).toBe(await ctx.db.count('autopilot_actions', { outcome: 'ESCALATED' }))
    expect(totals.minutesSaved).toBeGreaterThanOrEqual(0)
    expect(res.body.data.enabled).toBe(true)
  })

  it('shows attribution on the claim it handled', async () => {
    const [action] = await ctx.db.findMany('autopilot_actions', { where: { sweep_id: sweep.sweepId }, limit: 1 })
    const res = await ctx.as('manager.maria').get(`/claims/${action.claim_id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.autopilot.some((a) => a.action === action.action)).toBe(true)
  })

  it('is switched off again by a manager and then does nothing', async () => {
    const off = await ctx.as('compliance.carlos').put('/automation/autopilot/state', { enabled: false })
    expect(off.status).toBe(200)
    expect(await runScheduledAutopilot(ctx.deps)).toEqual({ ran: false, reason: 'DISABLED' })
    const audit = await ctx.db.query(`select count(*)::int as n from public.audit_logs where action in ('AI_AUTOPILOT_ENABLED', 'AI_AUTOPILOT_DISABLED')`)
    expect(audit[0].n).toBeGreaterThanOrEqual(2)
  })
})
