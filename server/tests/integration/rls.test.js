import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestContext } from '../helpers.js'

/**
 * Exercises the row-level security policies directly in PostgreSQL by switching
 * to the `authenticated` role with JWT claims (the test user must be allowed to
 * SET ROLE, e.g. a superuser).
 */
let ctx
let pg
beforeAll(async () => {
  ctx = await createTestContext()
  pg = ctx.deps.db.executor
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
  it('limits clients to their own claims, policies, payees and notifications', async () => {
    const alice = await ctx.userId('customer.alice')
    const claims = await asUser(alice, 'select customer_id, status from public.claims')
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every((c) => c.customer_id === alice)).toBe(true)
    const policies = await asUser(alice, 'select insured_id from public.policies')
    expect(policies.every((p) => p.insured_id === alice)).toBe(true)
    const payees = await asUser(alice, 'select customer_id from public.payees')
    expect(payees.every((p) => p.customer_id === alice)).toBe(true)
    const notes = await asUser(alice, 'select recipient_id from public.notifications')
    expect(notes.every((n) => n.recipient_id === alice)).toBe(true)
  })

  it('hides internal records from clients', async () => {
    const alice = await ctx.userId('customer.alice')
    for (const table of ['evaluations', 'reviews', 'reserves', 'claim_fraud_flags', 'audit_logs', 'payments', 'sla_clocks', 'policy_snapshots']) {
      expect(await asUser(alice, `select * from public.${table}`), table).toHaveLength(0)
    }
    const history = await asUser(alice, 'select customer_visible from public.claim_status_history')
    expect(history.every((h) => h.customer_visible)).toBe(true)
    const docs = await asUser(alice, 'select doc_type from public.documents')
    expect(docs.every((d) => !['INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE'].includes(d.doc_type))).toBe(true)
  })

  it('scopes staff (adjusters see only assigned claims and only the fraud band through the API)', async () => {
    const adam = await ctx.userId('adjuster.adam')
    const rows = await asUser(adam, 'select assigned_adjuster_id from public.claims')
    expect(rows.length).toBeGreaterThan(0)
    const ids = await asUser(adam, `select c.id from public.claims c where not exists (
      select 1 from public.claim_assignments a where a.claim_id = c.id and a.assignee_id = $1)`, [adam])
    expect(ids).toHaveLength(0)
    expect(await asUser(adam, 'select * from public.claim_fraud_flags')).toHaveLength(0)
  })

  it('gives data engineers claim headers but no claim children', async () => {
    const dana = await ctx.userId('data.dana')
    expect((await asUser(dana, 'select id from public.claims')).length).toBeGreaterThan(0)
    expect(await asUser(dana, 'select * from public.documents')).toHaveLength(0)
    expect(await asUser(dana, 'select * from public.claim_parties')).toHaveLength(0)
    expect((await asUser(dana, 'select * from public.integration_sync_runs')).length).toBeGreaterThan(0)
  })

  it('denies anonymous access entirely and direct access to partitions', async () => {
    await expect(asAnon('select * from public.claims')).rejects.toThrow(/permission denied/)
    const carlos = await ctx.userId('compliance.carlos')
    await expect(asUser(carlos, 'select * from public.audit_logs_default')).rejects.toThrow(/permission denied/)
  })

  it('lets clients create only drafts for themselves', async () => {
    const alice = await ctx.userId('customer.alice')
    const ben = await ctx.userId('customer.ben')
    await expect(asUser(alice, `insert into public.claims (customer_id, status) values ($1, 'DRAFT')`, [ben])).rejects.toThrow(/row-level security/)
    await expect(asUser(alice, `insert into public.claims (customer_id, status) values ($1, 'SUBMITTED')`, [alice])).rejects.toThrow()
    const ok = await asUser(alice, `insert into public.claims (customer_id, status, created_by) values ($1, 'DRAFT', $1) returning id`, [alice])
    expect(ok).toHaveLength(1)
  })

  it('prevents clients from advancing their own claim status directly', async () => {
    const alice = await ctx.userId('customer.alice')
    const claim = await ctx.claimByNumber('HPC-2026-000106')
    const rows = await asUser(alice, `update public.claims set status = 'PAID' where id = $1 returning id`, [claim.id])
    expect(rows).toHaveLength(0)
  })

  it('lets only Compliance & Security grant roles, never to themselves', async () => {
    const carlos = await ctx.userId('compliance.carlos')
    const alice = await ctx.userId('customer.alice')
    const maria = await ctx.userId('manager.maria')
    await expect(asUser(carlos, `insert into public.user_roles (user_id, role_code) values ($1, 'OPS_MANAGER')`, [carlos])).rejects.toThrow(/row-level security/)
    await expect(asUser(maria, `insert into public.user_roles (user_id, role_code) values ($1, 'ADJUSTER')`, [alice])).rejects.toThrow(/row-level security/)
    const granted = await asUser(carlos, `insert into public.user_roles (user_id, role_code) values ($1, 'DATA_ENGINEER') returning id`, [alice])
    expect(granted).toHaveLength(1)
  })

  it('blocks client writes to the audit log', async () => {
    const carlos = await ctx.userId('compliance.carlos')
    await expect(asUser(carlos, `insert into public.audit_logs (action, entity_type) values ('X', 'Y')`)).rejects.toThrow(/permission denied/)
  })
})
