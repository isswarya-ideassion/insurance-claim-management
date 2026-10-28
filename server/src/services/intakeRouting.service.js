import { ACTIVE_STATUSES, ROLES } from '../../../shared/constants.js'
import { recordAudit } from './audit.service.js'
import { notify, userIdsWithRole } from './notification.service.js'

// Routing is done by the system, so its audit rows are attributed to SYSTEM, not to the claimant.
const ROUTER = { id: null, type: 'SYSTEM', roles: ['SYSTEM'] }

async function isActiveClaimsOpsManager(t, userId) {
  if (!userId) return false
  const rows = await t.query(
    `select 1 from public.users u join public.user_roles r on r.user_id = u.id
      where u.id = $1 and u.is_active and r.role_code = $2`,
    [userId, ROLES.CLAIMS_OPS_MANAGER],
  )
  return rows.length > 0
}

/**
 * The active Claims Operations Manager with the lightest load: fewest open
 * claims owned, then fewest open tasks, then alphabetical (so the choice is
 * stable). The claimant is never picked for their own claim.
 */
export async function pickIntakeOwner(t, claim) {
  const rows = await t.query(
    `select u.id, u.full_name,
            (select count(*) from public.claims c
              where c.assigned_owner_id = u.id and c.status = any($2::text[]))::int as open_claims,
            (select count(*) from public.tasks k
              where k.owner_user_id = u.id and k.status in ('OPEN', 'IN_PROGRESS'))::int as open_tasks
       from public.users u
       join public.user_roles r on r.user_id = u.id and r.role_code = $1
      where u.is_active and u.id <> $3
      order by open_claims, open_tasks, u.full_name, u.id
      limit 1`,
    [ROLES.CLAIMS_OPS_MANAGER, [...ACTIVE_STATUSES, 'ON_HOLD'], claim.customer_id],
  )
  return rows[0] || null
}

/**
 * Assigns a newly submitted claim to a Claims Operations Manager, who owns it
 * through intake, coverage, routing and payee verification. A claim created
 * on a client's behalf by a Claims Operations Manager stays with that person.
 * Returns the owner's id, or null when nobody holds the role (the intake task
 * then waits in the role's queue and Claims Managers are told).
 */
export async function assignIntakeOwner(ctx, t, claim) {
  // An owner set earlier, or the staff member who raised the claim for the client, keeps it.
  const preferred = claim.assigned_owner_id || (claim.created_by !== claim.customer_id ? claim.created_by : null)
  let ownerId = (await isActiveClaimsOpsManager(t, preferred)) ? preferred : null
  let reason = 'Created by this Claims Operations Manager on the client’s behalf'
  if (!ownerId) {
    const pick = await pickIntakeOwner(t, claim)
    ownerId = pick?.id || null
    reason = pick ? `Automatic intake routing: lowest workload (${pick.open_claims} open claims, ${pick.open_tasks} open tasks)` : null
  }

  if (!ownerId) {
    await notify(ctx, t, {
      recipientIds: await userIdsWithRole(t, ROLES.OPS_MANAGER),
      claimId: claim.id,
      type: 'TASK_ASSIGNED',
      title: `No Claims Operations Manager available for ${claim.claim_number}`,
      message: 'The intake task is waiting in the Claims Operations Manager queue. Grant the role to someone or assign the claim manually.',
      link: `/claims/${claim.id}`,
      email: false,
    })
    return null
  }

  const current = await t.findOne('claim_assignments', { claim_id: claim.id, assignment_role: 'OPERATIONS_OWNER', is_active: true })
  if (current?.assignee_id !== ownerId) {
    if (current) await t.updateById('claim_assignments', current.id, { is_active: false, ended_at: new Date() })
    const assignment = await t.insert('claim_assignments', {
      claim_id: claim.id,
      assignee_id: ownerId,
      assignment_role: 'OPERATIONS_OWNER',
      assigned_by: null,
      reason,
    })
    await recordAudit(t, { ...ROUTER, requestId: ctx.actor?.requestId }, {
      action: 'CLAIM_AUTO_ASSIGNED',
      entityType: 'claim_assignment',
      entityId: assignment.id,
      claimId: claim.id,
      after: assignment,
      metadata: { assignmentRole: 'OPERATIONS_OWNER', reason },
    })
  }
  if (claim.assigned_owner_id !== ownerId) await t.updateById('claims', claim.id, { assigned_owner_id: ownerId })

  await notify(ctx, t, {
    recipientIds: [ownerId],
    claimId: claim.id,
    type: 'CLAIM_ASSIGNED',
    title: `New claim ${claim.claim_number} assigned to you`,
    message: 'Verify coverage, complete the intake checklist, collect and verify the payee details, then route the claim.',
    link: `/claims/${claim.id}`,
  })
  return ownerId
}
