import { createHash, randomUUID } from 'node:crypto'
import { PRIVACY_NOTICE_VERSION } from '../../../shared/constants.js'
import { DEMO_DOMAIN } from './demoData.js'

/**
 * FICTIONAL E2E DEMO DATA: two clean health policyholders (Meera, Rohan), their
 * policies, a verified payee, prior history and Rohan's withdrawn earlier claim
 * holding the forged bill that Beacon's duplicate-image check must catch.
 *
 * Idempotent: every step looks for its row first, so re-running it (or a
 * serverless cold start) never duplicates data. The forged bill is passed in
 * as bytes; this module never generates it and never reads demo-assets/.
 */
export const E2E_DOMAIN = DEMO_DOMAIN
export const E2E_RECEIPT_FILE_NAME = 'previous-claim-receipt.png'

const DAY = 86_400_000
const daysFrom = (d, n) => new Date(d.getTime() + n * DAY)
const iso = (d) => d.toISOString().slice(0, 10)

/** The two scenarios, with dates relative to `today` (the day the data is seeded). */
export function buildE2eScenario(today = new Date()) {
  const FLOW1 = {
    user: { email: `e2e.meera@${E2E_DOMAIN}`, fullName: 'Meera Krishnan', phone: '+91 98401 22871' },
    policy: {
      number: 'HP-HLT-E2E101',
      type: 'HEALTH',
      asset: 'Individual health plan - Platinum',
      sumInsured: 300000,
      deductible: 1000,
      // Realistic wording: Beacon matches the claimed loss type against these clauses.
      coverages: ['Hospitalisation and daycare surgery expenses', 'Outpatient consultation and diagnostic tests', 'Emergency ambulance transfer'],
      exclusions: ['Cosmetic or aesthetic treatment', 'Self-inflicted injury', 'Experimental therapy'],
      bankName: 'State Bank of India',
      account: '30981247765',
    },
    claim: {
      lossType: 'SURGERY',
      lossDate: daysFrom(today, -5),
      location: 'Lotus Speciality Hospital, 14 Greams Lane, Thousand Lights',
      city: 'Chennai',
      description: 'Daycare arthroscopic surgery on the right knee for a torn meniscus after a fall on wet stairs at home, with post-operative X-ray and blood tests. Discharged the same evening.',
      estimatedLoss: 18450,
    },
    // A settled claim eight months ago: an established customer, so triage finds trading history.
    prior: { lossType: 'OUTPATIENT', daysAgo: 240, amount: 3200, location: 'Lotus Speciality Hospital, Chennai', description: 'Outpatient consultation and blood tests for seasonal fever. Settled under the cashless network.' },
  }

  const FLOW2 = {
    user: { email: `e2e.rohan@${E2E_DOMAIN}`, fullName: 'Rohan Mehta', phone: '+91 98450 66713' },
    policy: {
      number: 'HP-HLT-E2E202',
      type: 'HEALTH',
      asset: 'Family floater health plan - Gold',
      sumInsured: 250000,
      deductible: 1000,
      coverages: ['Hospitalisation and daycare surgery expenses', 'Emergency room treatment and observation', 'Outpatient consultation and diagnostic tests'],
      exclusions: ['Cosmetic or aesthetic treatment', 'Self-inflicted injury', 'Experimental therapy'],
      bankName: 'HDFC Bank',
      account: '50100288419726',
    },
    claim: {
      lossType: 'EMERGENCY',
      lossDate: daysFrom(today, -6),
      location: 'Lakeside Care Hospital, Outer Ring Road, Bellandur',
      city: 'Bengaluru',
      description: 'Emergency room visit after a two-wheeler skid: wrist sprain and a cut to the forearm, cleaned and sutured, with an X-ray of the wrist. Discharged after four hours of observation.',
      estimatedLoss: 14500,
    },
    // An earlier claim of his, withdrawn after the bill was queried; it holds the same forged image.
    older: { lossType: 'OUTPATIENT', daysAgo: 15, amount: 9800, location: 'Lakeside Care Hospital, Bellandur', description: 'Outpatient treatment for a sprained ankle. Withdrawn by the claimant after the bill was queried.' },
    olderFileName: E2E_RECEIPT_FILE_NAME,
  }

  return { FLOW1, FLOW2 }
}

/**
 * Refuses a seed target that is not clearly a local database unless the caller
 * explicitly allowed it. Pure, so the rule is unit-tested.
 */
export function assertSeedTarget({ host, allowRemote }) {
  const local = ['localhost', '127.0.0.1', '::1', ''].includes(host)
  if (!local && !allowRemote) {
    throw new Error(`Refusing to seed "${host}": it is not localhost. Pass --allow-production only if this is the database you mean to seed.`)
  }
  return { local }
}

/**
 * Creates the E2E accounts, policies, payees, prior claims and the duplicate
 * receipt. `deps` is the object from createDependencies(); `receipt` is the
 * forged bill's PNG bytes (the same file as demo-assets/flow-2-.../forged-tampered-invoice.png).
 */
export async function seedE2eDemo(deps, { receipt, today = new Date() } = {}) {
  if (!Buffer.isBuffer(receipt) || receipt.length === 0) throw new Error('seedE2eDemo needs the receipt PNG bytes')
  const { db, crypto, storage, authProvider, config } = deps
  const { FLOW1, FLOW2 } = buildE2eScenario(today)
  const log = []

  const [priya] = await db.query('select id from public.users where email = $1', [`payments.priya@${E2E_DOMAIN}`])
  const [olivia] = await db.query('select id from public.users where email = $1', [`ops.olivia@${E2E_DOMAIN}`])
  if (!priya || !olivia) throw new Error('Demo staff users not found: seed the demo data first (npm run db:seed-demo)')

  const ensureUser = async (u) => {
    const existing = await db.findOne('users', { email: u.email })
    if (existing) return existing
    const created = await authProvider.createUser({ email: u.email, password: config.DEMO_PASSWORD, fullName: u.fullName, phone: u.phone, staff: false })
    await db.query(`insert into public.user_roles (user_id, role_code) values ($1, 'CLIENT') on conflict do nothing`, [created.id])
    await db.query(`insert into public.consents (subject_id, consent_type, notice_version, granted) values ($1, 'PRIVACY_NOTICE', $2, true)`, [created.id, PRIVACY_NOTICE_VERSION])
    log.push(`created client ${u.email}`)
    return db.findById('users', created.id)
  }

  const ensurePolicy = async (t, flow, user) => {
    const existing = await t.findOne('policies', { external_policy_no: flow.policy.number })
    if (existing) return existing
    const payee = await t.insert('payees', {
      customer_id: user.id,
      name: flow.user.fullName,
      payee_type: 'INDIVIDUAL',
      bank_name: flow.policy.bankName,
      bank_details_encrypted: crypto.encrypt(flow.policy.account),
      bank_last4: flow.policy.account.slice(-4),
      bank_details_hash: crypto.hash(flow.policy.account),
      verification_status: 'VERIFIED',
      verified_by: priya.id,
      verified_at: daysFrom(today, -280),
      sanctions_checked_at: daysFrom(today, -280),
      created_by: priya.id,
    })
    const policy = await t.insert('policies', {
      external_policy_no: flow.policy.number,
      insured_id: user.id,
      policy_type: flow.policy.type,
      segment: 'PERSONAL',
      insured_name: flow.user.fullName,
      status: 'ACTIVE',
      effective_date: iso(daysFrom(today, -300)),
      expiry_date: iso(daysFrom(today, 65)),
      sum_insured: flow.policy.sumInsured,
      deductible: flow.policy.deductible,
      premium: Math.round(flow.policy.sumInsured * 0.018),
      insured_asset: flow.policy.asset,
      coverage_summary: `${flow.policy.asset}. Cashless at network hospitals.`,
      coverages: flow.policy.coverages,
      exclusions: flow.policy.exclusions,
      limits: { sum_insured: flow.policy.sumInsured },
      deductibles: { per_claim: flow.policy.deductible },
      payee_id: payee.id,
      source_system: 'POLICY_ADMIN',
      source_synced_at: daysFrom(today, -1),
    })
    log.push(`created policy ${flow.policy.number} for ${flow.user.fullName} (payee verified, unique bank account)`)
    return policy
  }

  /** A closed historical claim (seed mode: claims may be inserted outside DRAFT). */
  const ensureClosedClaim = async (t, policy, user, spec, closureReason) => {
    const existing = await t.findOne('claims', { policy_id: policy.id, loss_description: spec.description })
    if (existing) return existing
    const [{ n }] = await t.query('select public.next_claim_number() as n')
    const opened = daysFrom(today, -spec.daysAgo)
    const claim = await t.insert('claims', {
      claim_number: n,
      customer_id: user.id,
      policy_id: policy.id,
      claim_type: policy.policy_type,
      segment: policy.segment,
      status: 'CLOSED',
      priority: 'LOW',
      severity: 'LOW',
      complexity: 1,
      insured_name: policy.insured_name,
      loss_date: daysFrom(opened, -2),
      loss_location: spec.location,
      loss_city: spec.location.split(', ').pop(),
      loss_country: 'India',
      loss_type: spec.lossType,
      loss_description: spec.description,
      estimated_loss: spec.amount,
      affected_asset: policy.insured_asset,
      declaration_accepted: true,
      declaration_accepted_at: opened,
      draft_step: 6,
      opened_at: opened,
      assigned_owner_id: olivia.id,
      coverage_result: 'COVERED',
      closure_reason: closureReason,
      closed_at: daysFrom(opened, Math.min(20, Math.max(1, spec.daysAgo - 8))),
      created_by: user.id,
      created_at: opened,
    })
    log.push(`created closed claim ${n} for ${user.full_name} (${closureReason})`)
    return claim
  }

  const meera = await ensureUser(FLOW1.user)
  const rohan = await ensureUser(FLOW2.user)
  await db.tx(async (t) => {
    await t.query(`select set_config('app.seed_mode', 'on', true)`)
    const p1 = await ensurePolicy(t, FLOW1, meera)
    await ensureClosedClaim(t, p1, meera, FLOW1.prior, 'Settled under the cashless network')
    const p2 = await ensurePolicy(t, FLOW2, rohan)
    const older = await ensureClosedClaim(t, p2, rohan, FLOW2.older, 'Withdrawn by the claimant after the bill was queried')

    // The byte-identical forged bill on the older claim, so the duplicate check fires on upload.
    const sha = createHash('sha256').update(receipt).digest('hex')
    const have = await t.query(
      `select 1 from public.documents d join public.document_files f on f.storage_key = d.storage_key where d.claim_id = $1 and f.sha256 = $2 limit 1`,
      [older.id, sha],
    )
    if (!have.length) {
      const id = randomUUID()
      const storageKey = `claims/${older.id}/${id}.png`
      const received = daysFrom(today, -13)
      await storage.put(storageKey, receipt, 'image/png', t)
      const doc = await t.insert('documents', {
        id,
        claim_id: older.id,
        version: 1,
        doc_type: 'INVOICE',
        file_name: FLOW2.olderFileName,
        storage_key: storageKey,
        mime_type: 'image/png',
        size_bytes: receipt.length,
        sha256: sha,
        source: 'WEB',
        status: 'ACCEPTED',
        uploaded_by: rohan.id,
        received_at: received,
        reviewer_id: null,
        reviewed_by: null,
      })
      await t.insert('document_versions', { document_id: doc.id, version_no: 1, storage_key: storageKey, file_name: doc.file_name, mime_type: 'image/png', size_bytes: receipt.length, sha256: sha, status: 'ACCEPTED', uploaded_by: rohan.id, uploaded_at: received })
      log.push(`filed ${FLOW2.olderFileName} (sha256 ${sha.slice(0, 12)}...) on ${older.claim_number}`)
    }
  })

  // Neither test policyholder may sit in a fraud ring (they share no bank account, payee or premises with anyone).
  const rings = await db.query(
    `select r.band, r.status from public.fraud_rings r join public.fraud_ring_members m on m.ring_id = r.id where m.entity_id = any($1::uuid[]) and r.status <> 'DISMISSED'`,
    [[meera.id, rohan.id]],
  )
  if (rings.length) throw new Error(`a test policyholder is in a fraud ring: ${JSON.stringify(rings)}`)

  const olderClaim = await db.query(`select c.claim_number from public.claims c join public.policies p on p.id = c.policy_id where p.external_policy_no = $1 and c.status = 'CLOSED' order by c.opened_at limit 1`, [FLOW2.policy.number])
  return { log, olderClaimNumber: olderClaim[0]?.claim_number || null, staffPassword: '(the DEMO_PASSWORD from server/.env)' }
}
