import { ROLES, SLA_PAUSED_STATUSES } from '../../../shared/constants.js'
import { logger } from '../config/logger.js'
import { hoursFromNow } from '../utils/format.js'
import { slaHours } from './config.service.js'
import { notify, userIdsWithRole, claimLink } from './notification.service.js'

const ACKNOWLEDGE_MINUTES = 5

async function runningClock(t, claimId) {
  return t.findOne('sla_clocks', { claim_id: claimId, clock_type: 'STAGE', stopped_at: null }, { forUpdate: true })
}

/**
 * Keeps the stage clock in step with a status change (PRD section 3.10) and
 * returns the due date to store on the claim. Holds pause the running clock
 * and resuming extends its due date by the paused time; every other move stops
 * the clock and starts one for the new status when that status has a target.
 */
export async function recordStageChange(t, claim, toStatus, now = new Date()) {
  const from = claim.status
  const clock = await runningClock(t, claim.id)

  if (toStatus === 'ON_HOLD') {
    if (clock && !clock.paused_at) await t.updateById('sla_clocks', clock.id, { paused_at: now, pause_reason: 'Claim on hold' })
    return clock?.due_at ?? null
  }

  if (from === 'ON_HOLD' && clock && clock.stage === toStatus) {
    if (!clock.paused_at) return clock.due_at
    const pausedMs = now.getTime() - new Date(clock.paused_at).getTime()
    const due = clock.due_at ? new Date(new Date(clock.due_at).getTime() + pausedMs) : null
    await t.updateById('sla_clocks', clock.id, {
      paused_at: null,
      pause_reason: null,
      paused_seconds: clock.paused_seconds + Math.round(pausedMs / 1000),
      due_at: due,
    })
    return due
  }

  if (clock) await t.updateById('sla_clocks', clock.id, { stopped_at: now, paused_at: null })
  const hours = await slaHours(t, claim.segment, toStatus)
  if (!hours) return null
  const due = hoursFromNow(hours, now)
  const waiting = SLA_PAUSED_STATUSES.includes(toStatus)
  await t.insert('sla_clocks', {
    claim_id: claim.id,
    clock_type: 'STAGE',
    stage: toStatus,
    segment: claim.segment,
    started_at: now,
    due_at: due,
    // While the client owes documents the insurer clock is paused; due_at is the client deadline.
    paused_at: waiting ? now : null,
    pause_reason: waiting ? 'Waiting on client' : null,
  })
  return due
}

/** Acknowledgement clock: the automated acknowledgement is sent in the submitting transaction. */
export async function recordAcknowledgement(t, claim, now = new Date()) {
  await t.insert('sla_clocks', {
    claim_id: claim.id,
    clock_type: 'ACKNOWLEDGE',
    stage: 'SUBMITTED',
    segment: claim.segment,
    started_at: now,
    due_at: new Date(now.getTime() + ACKNOWLEDGE_MINUTES * 60_000),
    stopped_at: now,
  })
}

export async function claimClocks(t, claimId) {
  const rows = await t.findMany('sla_clocks', { where: { claim_id: claimId }, orderBy: [['started_at', 'desc']] })
  const now = Date.now()
  return rows.map((c) => {
    const running = !c.stopped_at
    const remainingMs = running && c.due_at && !c.paused_at ? new Date(c.due_at).getTime() - now : null
    return { ...c, running, remaining_hours: remainingMs == null ? null : Math.round(remainingMs / 360_000) / 10 }
  })
}

/**
 * Escalation ladder: level 1 when a running, unpaused clock passes its due
 * date (stage owner and Claims Managers are notified); level 2 when it is late
 * by half of its target again (Claims Managers, claim marked for the bottleneck board).
 */
export async function runSlaSweep(deps, { now = new Date() } = {}) {
  const ctx = { ...deps, actor: { id: null, roles: ['SYSTEM'], requestId: 'sla-sweep' } }
  const late = await deps.db.query(
    `select * from public.sla_clocks
      where stopped_at is null and paused_at is null and due_at < $1 and escalation_level < 2
      order by due_at limit 500`,
    [now],
  )
  let escalated = 0
  for (const clock of late) {
    await deps.db.tx(async (t) => {
      const claim = await t.findById('claims', clock.claim_id)
      if (!claim) return
      const duration = new Date(clock.due_at).getTime() - new Date(clock.started_at).getTime()
      const level = now.getTime() > new Date(clock.due_at).getTime() + duration / 2 ? 2 : 1
      if (level <= clock.escalation_level) return
      await t.updateById('sla_clocks', clock.id, { escalation_level: level, breached_at: clock.breached_at || now })
      if (level === 2 && claim.escalation_level < 2) await t.updateById('claims', claim.id, { escalation_level: 2, escalated_at: now })
      const managers = await userIdsWithRole(t, ROLES.OPS_MANAGER)
      const owners = level === 1 ? [claim.assigned_owner_id, claim.assigned_adjuster_id, claim.assigned_reviewer_id] : []
      await notify(ctx, t, {
        recipientIds: [...owners, ...managers],
        claimId: claim.id,
        type: 'SLA_BREACHED',
        title: `SLA ${level === 2 ? 'level 2 escalation' : 'breached'}: ${claim.claim_number}`,
        message: `The ${clock.stage.toLowerCase().replace(/_/g, ' ')} target was ${new Date(clock.due_at).toUTCString()}.`,
        link: claimLink(claim, false),
        email: level === 2,
      })
      escalated += 1
    })
  }
  if (escalated) logger.info('sla sweep complete', { escalated })
  return { checked: late.length, escalated }
}
