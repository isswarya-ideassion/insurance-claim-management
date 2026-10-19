import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

/**
 * Exercises the Supabase row-level security policies directly in PGlite by
 * switching to the `authenticated` role with JWT claims, exactly as PostgREST does.
 */
let ctx
let pg
beforeAll(async () => {
  ctx = await createTestContext()
  pg = ctx.deps.db.executor.raw
})
afterAll(() => ctx.close())

async function asUser(userId, sql, params = []) {
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    await tx.query('set local role authenticated')
    return (await tx.query(sql, params)).rows
  })
}

async function asAnon(sql) {
  return pg.transaction(async (tx) => {
    await tx.query('set local role anon')
    return (await tx.query(sql)).rows
  })
}

describe('row-level security', () => {
  it('limits customers to their own claims, policies and notifications', async () => {
    const alice = await ctx.userId('customer.alice')
    const claims = await asUser(alice, 'select customer_id, status from public.claims')
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.customer_id === alice)).toBe(true)
    const policies = await asUser(alice, 'select holder_id from public.policies')
    expect(policies.every((p) => p.holder_id === alice)).toBe(true)
    const notes = await asUser(alice, 'select recipient_id from public.notifications')
    expect(notes.every((n) => n.recipient_id === alice)).toBe(true)
  })

  it('hides internal records from customers', async () => {
    const alice = await ctx.userId('customer.alice')
    expect(await asUser(alice, 'select * from public.assessments')).toHaveLength(0)
    expect(await asUser(alice, 'select * from public.compliance_reviews')).toHaveLength(0)
    expect(await asUser(alice, 'select * from public.audit_logs')).toHaveLength(0)
    const history = await asUser(alice, 'select customer_visible from public.claim_status_history')
    expect(history.every((h) => h.customer_visible)).toBe(true)
  })

  it('scopes staff (adjusters see only assigned claims)', async () => {
    const adam = await ctx.userId('adjuster.adam')
    const rows = await asUser(adam, 'select assigned_adjuster_id from public.claims')
    expect(rows.length).toBeGreaterThan(0)
    const ids = await asUser(adam, `select c.id from public.claims c where not exists (
      select 1 from public.claim_assignments a where a.claim_id = c.id and a.assignee_id = $1)`, [adam])
    expect(ids).toHaveLength(0)
  })

  it('denies anonymous access entirely', async () => {
    await expect(asAnon('select * from public.claims')).rejects.toThrow(/permission denied/)
  })

  it('lets customers create only drafts for themselves', async () => {
    const alice = await ctx.userId('customer.alice')
    const ben = await ctx.userId('customer.ben')
    await expect(asUser(alice, `insert into public.claims (customer_id, status) values ($1, 'DRAFT')`, [ben])).rejects.toThrow(/row-level security/)
    await expect(asUser(alice, `insert into public.claims (customer_id, status) values ($1, 'SUBMITTED')`, [alice])).rejects.toThrow()
    const ok = await asUser(alice, `insert into public.claims (customer_id, status, created_by) values ($1, 'DRAFT', $1) returning id`, [alice])
    expect(ok).toHaveLength(1)
  })

  it('prevents customers from advancing their own claim status directly', async () => {
    const alice = await ctx.userId('customer.alice')
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const rows = await asUser(alice, `update public.claims set status = 'PAID' where id = $1 returning id`, [claim.id])
    expect(rows).toHaveLength(0)
  })

  it('prevents role self-escalation even for data administrators', async () => {
    const dana = await ctx.userId('admin.dana')
    const alice = await ctx.userId('customer.alice')
    await expect(asUser(dana, `insert into public.user_roles (user_id, role_code) values ($1, 'CLAIMS_MANAGER')`, [dana])).rejects.toThrow(/row-level security/)
    await expect(asUser(alice, `insert into public.user_roles (user_id, role_code) values ($1, 'DATA_ADMIN')`, [alice])).rejects.toThrow(/row-level security/)
    const granted = await asUser(dana, `insert into public.user_roles (user_id, role_code) values ($1, 'AUDITOR') returning id`, [alice])
    expect(granted).toHaveLength(1)
  })

  it('blocks client writes to the audit log', async () => {
    const dana = await ctx.userId('admin.dana')
    await expect(asUser(dana, `insert into public.audit_logs (action, entity_type) values ('X', 'Y')`)).rejects.toThrow(/permission denied/)
  })
})
