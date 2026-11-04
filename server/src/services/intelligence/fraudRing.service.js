import { createHash } from 'node:crypto'

/**
 * Organised-fraud ring detection.
 *
 * A single claim from a shell entity is unremarkable: a small company, a modest
 * loss, papers in order. The arrangement only becomes visible one level up —
 * several "unrelated" entities sharing a building, a bank account or a payee,
 * claiming inside the same window. So the unit of scoring here is the RING
 * (a connected component of entities), not the claim.
 *
 * Entities are linked by facts, never by inference: identical building hash,
 * identical bank-account HMAC, or the same payee record. Each link basis is
 * recorded so a Compliance reviewer can see why two entities were joined.
 */

export const RING_SIGNALS = {
  SHARED_REGISTERED_ADDRESS: 15,
  VIRTUAL_OFFICE_ADDRESS: 10,
  PREMISES_NOT_FOUND: 55,
  SHARED_BANK_ACCOUNT: 50,
  RAPID_CLAIM_AFTER_INCEPTION: 25,
  CORRELATED_RING_TIMING: 30,
  NO_TRADING_HISTORY: 10,
}

/**
 * Signals that make an address collision meaningful. Without at least one of
 * these the ring cannot rise above LOW.
 *
 * This gate is the whole design. A co-working tower legitimately hosts hundreds
 * of real companies, so "same registered address" on its own is near-worthless
 * as evidence and catastrophic as a trigger — it would flag every genuine
 * startup in the building. Address sharing is corroboration; these are the
 * facts that are hard to explain away.
 */
const CORROBORATING = ['PREMISES_NOT_FOUND', 'SHARED_BANK_ACCOUNT', 'CORRELATED_RING_TIMING', 'RAPID_CLAIM_AFTER_INCEPTION']

const FAILED_VISIT = new Set(['NOT_FOUND', 'VACANT', 'OCCUPANT_DENIES', 'MAIL_DROP_ONLY'])

const RAPID_CLAIM_DAYS = 60
const CORRELATION_WINDOW_DAYS = 45

const band = (score) => (score >= 80 ? 'CRITICAL' : score >= 55 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW')
const days = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 86_400_000) : null)

/** Union-find over entity ids; each union records why it happened. */
class Links {
  constructor() {
    this.parent = new Map()
    this.reasons = new Map()
  }

  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    while (this.parent.get(x) !== root) {
      const next = this.parent.get(x)
      this.parent.set(x, root)
      x = next
    }
    return root
  }

  union(a, b, basis) {
    const [ra, rb] = [this.find(a), this.find(b)]
    const key = [a, b].sort().join('|')
    if (!this.reasons.has(key)) this.reasons.set(key, new Set())
    this.reasons.get(key).add(basis)
    if (ra !== rb) this.parent.set(ra, rb)
  }

  components() {
    const groups = new Map()
    for (const node of this.parent.keys()) {
      const root = this.find(node)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(node)
    }
    return [...groups.values()].filter((g) => g.length > 1)
  }
}

/**
 * Pure scoring over assembled ring facts, so it can be tested without a
 * database and reasoned about on its own.
 *
 * @param {{entityIds: string[], premises: object[], verifications: object[],
 *          sharedBankAccounts: number, claims: object[]}} facts
 */
export function scoreRing(facts) {
  const signals = []
  const add = (code, detail) => signals.push({ code, weight: RING_SIGNALS[code], detail })

  const hashes = new Set(facts.premises.map((p) => p.premises_hash).filter(Boolean))
  const sharedHash = [...hashes].find(
    (h) => new Set(facts.premises.filter((p) => p.premises_hash === h).map((p) => p.entity_id)).size > 1,
  )
  if (sharedHash) {
    const at = facts.premises.filter((p) => p.premises_hash === sharedHash)
    add('SHARED_REGISTERED_ADDRESS', `${new Set(at.map((p) => p.entity_id)).size} entities share one building`)
    if (at.some((p) => p.is_shared_workspace)) {
      add('VIRTUAL_OFFICE_ADDRESS', at.find((p) => p.workspace_provider)?.workspace_provider ?? 'shared workspace')
    }
  }

  const failed = facts.verifications.filter((v) => FAILED_VISIT.has(v.outcome))
  if (failed.length) add('PREMISES_NOT_FOUND', `${failed.length} visit(s): ${[...new Set(failed.map((v) => v.outcome))].join(', ')}`)

  if (facts.sharedBankAccounts > 0) add('SHARED_BANK_ACCOUNT', `${facts.sharedBankAccounts} account(s) used by more than one entity`)

  const gaps = facts.claims.map((c) => days(c.effective_from, c.loss_date)).filter((d) => d != null && d >= 0)
  if (gaps.length && gaps.filter((d) => d <= RAPID_CLAIM_DAYS).length >= Math.max(2, Math.ceil(gaps.length / 2))) {
    add('RAPID_CLAIM_AFTER_INCEPTION', `median gap ${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]} days from inception to loss`)
  }

  const reported = facts.claims.map((c) => c.opened_at).filter(Boolean).map((d) => new Date(d)).sort((a, b) => a - b)
  if (reported.length > 1 && days(reported[0], reported[reported.length - 1]) <= CORRELATION_WINDOW_DAYS) {
    add('CORRELATED_RING_TIMING', `${reported.length} claims reported within ${days(reported[0], reported[reported.length - 1])} days`)
  }

  if (facts.claims.length && facts.claims.every((c) => (c.prior_claims ?? 0) === 0)) {
    add('NO_TRADING_HISTORY', 'no entity in the ring has prior claim history')
  }

  const corroborated = signals.some((s) => CORROBORATING.includes(s.code))
  const raw = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0))
  // Uncorroborated address sharing is held at LOW however many entities share
  // the building — otherwise every co-working tower becomes a fraud ring.
  const score = corroborated ? raw : Math.min(raw, 29)

  return { score, band: band(score), corroborated, signals }
}

const ringKey = (entityIds) => createHash('sha256').update([...entityIds].sort().join('|')).digest('hex').slice(0, 32)

/** Loads the facts, links entities, scores each ring and upserts the results. */
export async function detectRings(db, { minScore = 30 } = {}) {
  const [claims, premises, verifications, bank] = await Promise.all([
    db.query(`
      select c.id as claim_id, c.customer_id as entity_id, c.claim_number, c.loss_date, c.opened_at,
             c.estimated_loss, c.status, p.effective_date as effective_from,
             (select count(*) from public.claims x
               where x.customer_id = c.customer_id and x.id <> c.id
                 and x.status not in ('DRAFT', 'WITHDRAWN') and x.opened_at < c.opened_at)::int as prior_claims
        from public.claims c
        left join public.policies p on p.id = c.policy_id
       where c.status not in ('DRAFT', 'WITHDRAWN')`),
    db.query(`select id, entity_id, premises_hash, is_shared_workspace, workspace_provider, unit_label
                from public.entity_premises where premises_hash is not null`),
    db.query(`select ep.entity_id, pv.outcome, pv.visited_at, pv.claim_id
                from public.premises_verifications pv
                join public.entity_premises ep on ep.id = pv.entity_premises_id`),
    db.query(`
      select distinct c.customer_id as entity_id, py.bank_details_hash
        from public.payments pm
        join public.payees py on py.id = pm.payee_id
        join public.claims c on c.id = pm.claim_id
       where py.bank_details_hash is not null and pm.status not in ('REJECTED', 'CANCELLED')`),
  ])

  const links = new Links()
  const groupBy = (rows, key) => {
    const map = new Map()
    for (const r of rows) {
      if (!r[key]) continue
      if (!map.has(r[key])) map.set(r[key], new Set())
      map.get(r[key]).add(r.entity_id)
    }
    return map
  }

  for (const [, entities] of groupBy(premises, 'premises_hash')) {
    const list = [...entities]
    for (let i = 1; i < list.length; i += 1) links.union(list[0], list[i], 'PREMISES')
  }
  const sharedAccounts = new Map()
  for (const [hash, entities] of groupBy(bank, 'bank_details_hash')) {
    const list = [...entities]
    if (list.length > 1) sharedAccounts.set(hash, list)
    for (let i = 1; i < list.length; i += 1) links.union(list[0], list[i], 'BANK_ACCOUNT')
  }

  const rings = []
  for (const entityIds of links.components()) {
    const set = new Set(entityIds)
    const facts = {
      entityIds,
      premises: premises.filter((p) => set.has(p.entity_id)),
      verifications: verifications.filter((v) => set.has(v.entity_id)),
      sharedBankAccounts: [...sharedAccounts.values()].filter((list) => list.some((e) => set.has(e))).length,
      claims: claims.filter((c) => set.has(c.entity_id)),
    }
    const scored = scoreRing(facts)
    if (scored.score < minScore) continue
    rings.push({ key: ringKey(entityIds), entityIds, facts, ...scored })
  }

  for (const ring of rings) {
    await db.tx(async (t) => {
      const [saved] = await t.query(
        `insert into public.fraud_rings (ring_key, link_basis, entity_count, claim_count, score, band, signals, last_evaluated_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (ring_key) do update set
           entity_count = excluded.entity_count, claim_count = excluded.claim_count,
           score = excluded.score, band = excluded.band, signals = excluded.signals,
           last_evaluated_at = now()
         returning id`,
        [
          ring.key,
          [...new Set(ring.signals.map((s) => s.code))],
          ring.entityIds.length,
          ring.facts.claims.length,
          ring.score,
          ring.band,
          JSON.stringify(ring.signals),
        ],
      )
      for (const entityId of ring.entityIds) {
        await t.query(
          `insert into public.fraud_ring_members (ring_id, entity_id, premises_hash, claim_ids)
           values ($1, $2, $3, $4)
           on conflict (ring_id, entity_id) do update set claim_ids = excluded.claim_ids`,
          [
            saved.id,
            entityId,
            ring.facts.premises.find((p) => p.entity_id === entityId)?.premises_hash ?? null,
            ring.facts.claims.filter((c) => c.entity_id === entityId).map((c) => c.claim_id),
          ],
        )
      }
    })
  }

  return { ringsEvaluated: links.components().length, ringsRecorded: rings.length, rings }
}
