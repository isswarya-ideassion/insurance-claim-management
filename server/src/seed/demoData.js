import { randomUUID, createHash } from 'node:crypto'
import {
  CUSTOMER_STATUS_LABELS,
  INTAKE_CHECKLIST,
  INVESTIGATION_CHECKLIST,
  COMPLIANCE_CHECKLIST,
  PRIVACY_NOTICE_VERSION,
  REQUIRED_DOCUMENTS,
  defaultCoverageLine,
} from '../../../shared/constants.js'
import { STATUS_SLA_HOURS } from '../../../shared/workflow.js'
import { buildSamplePdf } from './samplePdf.js'

/**
 * FICTIONAL DEMO DATA. All people, policies and claims are invented.
 * Loaded when the API starts with SEED_DEMO_DATA=true, or by `npm run db:seed-demo`.
 * Users are always created through the authentication provider first; user
 * rows come from the auth trigger.
 */
export const DEMO_DOMAIN = 'demo.harborpoint.test'

// One account per PRD role, plus a second manager (higher authority) and a
// second payment operator so separation of duties can be demonstrated.
export const DEMO_USERS = [
  { key: 'alice', email: `customer.alice@${DEMO_DOMAIN}`, fullName: 'Alice Thornton', phone: '+91 98450 10101', roles: ['CLIENT'] },
  { key: 'ben', email: `customer.ben@${DEMO_DOMAIN}`, fullName: 'Benjamin Okafor', phone: '+91 98450 10102', roles: ['CLIENT'] },
  { key: 'chen', email: `customer.chen@${DEMO_DOMAIN}`, fullName: 'Chen Wei', phone: '+91 98450 10103', roles: ['CLIENT'] },
  // Claims Operations Managers own new claims; `replaces` lists roles an older demo database gave them.
  { key: 'olivia', email: `ops.olivia@${DEMO_DOMAIN}`, fullName: 'Olivia Martins', roles: ['CLAIMS_OPS_MANAGER'], replaces: ['OPS_MANAGER'] },
  { key: 'omar', email: `ops.omar@${DEMO_DOMAIN}`, fullName: 'Omar Haddad', roles: ['CLAIMS_OPS_MANAGER'] },
  // Claims Managers: approvals, denials, closure and reopening.
  { key: 'maria', email: `manager.maria@${DEMO_DOMAIN}`, fullName: 'Maria Gonzalez', roles: ['OPS_MANAGER'], limits: { reserve: 50000, settlement: 50000 } },
  { key: 'sam', email: `manager.sam@${DEMO_DOMAIN}`, fullName: 'Samuel Reed', roles: ['OPS_MANAGER'], limits: { reserve: 250000, settlement: 250000 } },
  { key: 'raj', email: `reviewer.raj@${DEMO_DOMAIN}`, fullName: 'Raj Patel', roles: ['DOCUMENT_REVIEWER'] },
  { key: 'adam', email: `adjuster.adam@${DEMO_DOMAIN}`, fullName: 'Adam Brooks', roles: ['ADJUSTER'] },
  { key: 'amara', email: `adjuster.amara@${DEMO_DOMAIN}`, fullName: 'Amara Nwosu', roles: ['ADJUSTER'] },
  { key: 'priya', email: `payments.priya@${DEMO_DOMAIN}`, fullName: 'Priya Raman', roles: ['PAYMENT_OPERATOR'] },
  { key: 'paul', email: `payments.paul@${DEMO_DOMAIN}`, fullName: 'Paul Lindgren', roles: ['PAYMENT_OPERATOR'] },
  { key: 'dana', email: `data.dana@${DEMO_DOMAIN}`, fullName: 'Dana Kowalski', roles: ['DATA_ENGINEER'] },
  { key: 'carlos', email: `compliance.carlos@${DEMO_DOMAIN}`, fullName: 'Carlos Mendes', roles: ['COMPLIANCE_SECURITY'] },
  // Second Compliance & Security user, focused on centralized customer records.
  { key: 'rosa', email: `records.rosa@${DEMO_DOMAIN}`, fullName: 'Rosa Lindqvist', roles: ['COMPLIANCE_SECURITY'] },
]

// Personal-segment settlement authority by role (authority_limits), recorded on seeded decisions.
const ROLE_SETTLEMENT_LIMITS = { ADJUSTER: 15000, OPS_MANAGER: 250000 }

const HOUR = 3600_000
const DAY = 24 * HOUR
const ago = (days, hours = 0) => new Date(Date.now() - days * DAY - hours * HOUR)

const PATHS = {}
PATHS.SUBMITTED = []
PATHS.POLICY_VERIFICATION = ['POLICY_VERIFICATION']
PATHS.DOCUMENTS_REQUIRED = ['POLICY_VERIFICATION', 'DOCUMENT_REVIEW', 'DOCUMENTS_REQUIRED']
PATHS.DOCUMENT_REVIEW = ['POLICY_VERIFICATION', 'DOCUMENT_REVIEW']
PATHS.ADJUSTER_ASSIGNMENT = [...PATHS.DOCUMENT_REVIEW, 'ADJUSTER_ASSIGNMENT']
PATHS.INVESTIGATION = [...PATHS.ADJUSTER_ASSIGNMENT, 'INVESTIGATION']
PATHS.RESERVE_APPROVAL = [...PATHS.INVESTIGATION, 'RESERVE_APPROVAL']
// Reserves within the adjuster's authority are posted and the claim goes straight to compliance.
PATHS.COMPLIANCE_REVIEW = [...PATHS.INVESTIGATION, 'COMPLIANCE_REVIEW']
PATHS.SETTLEMENT_APPROVAL = [...PATHS.COMPLIANCE_REVIEW, 'SETTLEMENT_APPROVAL']
PATHS.PAYMENT_PENDING = [...PATHS.SETTLEMENT_APPROVAL, 'PAYMENT_PENDING']
PATHS.PAYMENT_FAILED = [...PATHS.PAYMENT_PENDING, 'PAYMENT_FAILED']
PATHS.PAID = [...PATHS.PAYMENT_PENDING, 'PAID']
PATHS.CLOSED = [...PATHS.PAID, 'CLOSED']

const STEP_ACTOR = {
  SUBMITTED: 'customer',
  POLICY_VERIFICATION: 'olivia',
  DOCUMENTS_REQUIRED: 'raj',
  DOCUMENT_REVIEW: 'olivia',
  ADJUSTER_ASSIGNMENT: 'raj',
  INVESTIGATION: 'maria',
  RESERVE_APPROVAL: 'adjuster',
  COMPLIANCE_REVIEW: 'adjuster',
  SETTLEMENT_APPROVAL: 'carlos',
  PAYMENT_PENDING: 'maria',
  PAYMENT_FAILED: 'priya',
  PAID: 'priya',
  CLOSED: 'maria',
  REJECTED: 'maria',
  WITHDRAWN: 'customer',
  ON_HOLD: 'olivia',
}

const fullChecklist = (items, who) =>
  Object.fromEntries(items.map((i) => [i.key, { checked: true, by: who.id, by_name: who.full_name, at: ago(5).toISOString() }]))

export async function demoDataExists(db) {
  const rows = await db.query('select count(*)::int as count from public.users where email like $1', [`%@${DEMO_DOMAIN}`])
  return rows[0].count > 0
}

async function grantDemoRoles(t, user, id) {
  for (const role of user.roles) {
    await t.query(`insert into public.user_roles (user_id, role_code) values ($1, $2) on conflict (user_id, role_code) do nothing`, [id, role])
  }
  if (user.limits) {
    await t.query(
      `insert into public.user_attributes (user_id, reserve_limit, settlement_limit) values ($1, $2, $3)
       on conflict (user_id) do update set reserve_limit = excluded.reserve_limit, settlement_limit = excluded.settlement_limit`,
      [id, user.limits.reserve, user.limits.settlement],
    )
  }
  if (user.roles.includes('CLIENT')) {
    await t.query(
      `insert into public.consents (subject_id, consent_type, notice_version, granted) values ($1, 'PRIVACY_NOTICE', $2, true)`,
      [id, PRIVACY_NOTICE_VERSION],
    )
  }
}

/**
 * Brings an existing demo database up to date: creates missing demo accounts,
 * grants roles a demo account is missing, and removes roles it was given by an
 * older demo seed (`replaces`). Other role changes made by an admin are kept.
 */
export async function ensureDemoUsers({ db, createUser, password, log = () => {} }) {
  for (const u of DEMO_USERS) {
    const existing = await db.findOne('users', { email: u.email })
    if (!existing) {
      const created = await createUser({ email: u.email, password, fullName: u.fullName, phone: u.phone, staff: !u.roles.includes('CLIENT') })
      await db.tx((t) => grantDemoRoles(t, u, created.id))
      log(`added demo user ${u.email}`)
      continue
    }
    const held = (await db.findMany('user_roles', { where: { user_id: existing.id } })).map((r) => r.role_code)
    const missing = u.roles.filter((r) => !held.includes(r))
    const stale = (u.replaces || []).filter((r) => held.includes(r) && !u.roles.includes(r))
    if (!missing.length && !stale.length) continue
    await db.tx(async (t) => {
      await grantDemoRoles(t, u, existing.id)
      for (const role of stale) await t.query('delete from public.user_roles where user_id = $1 and role_code = $2', [existing.id, role])
      if (stale.length && !u.limits) await t.query('delete from public.user_attributes where user_id = $1', [existing.id])
    })
    log(`updated demo roles for ${u.email}: +${missing.join(',') || '-'} -${stale.join(',') || '-'}`)
  }
}

/**
 * @param {object}   opts
 * @param {object}   opts.db          repository (seed runs in one transaction)
 * @param {object}   opts.storage     storage adapter for placeholder documents
 * @param {object}   opts.crypto      field encryption (bank details, contact data)
 * @param {Function} opts.createUser  ({ email, password, fullName, phone, staff }) => { id }
 * @param {string}   opts.password    password for every demo account
 */
export async function seedDemoData({ db, storage, crypto, createUser, password, log = () => {} }) {
  const users = {}
  for (const u of DEMO_USERS) {
    const existing = await db.findOne('users', { email: u.email })
    const created = existing || (await createUser({ email: u.email, password, fullName: u.fullName, phone: u.phone, staff: !u.roles.includes('CLIENT') }))
    users[u.key] = { ...u, id: created.id, full_name: u.fullName }
  }
  log(`demo users ready (${DEMO_USERS.length})`)

  const files = []
  const result = await db.tx(async (t) => {
    await t.query(`select set_config('app.seed_mode', 'on', true)`)

    for (const u of DEMO_USERS) {
      await t.update('users', { id: users[u.key].id }, { full_name: u.fullName, phone: u.phone || null })
      await grantDemoRoles(t, u, users[u.key].id)
    }

    // ------------------------------------------------------------------ policies and payees
    const year = new Date().getUTCFullYear()
    const policySpecs = [
      { key: 'aliceMotor', number: 'HP-MOT-100231', holder: 'alice', type: 'MOTOR', asset: '2023 Volvo XC40 — plate HPT-4821', sum: 45000, deductible: 500, account: '40221187' },
      { key: 'aliceHome', number: 'HP-PRP-200418', holder: 'alice', type: 'PROPERTY', asset: '14 Harbor View Lane, Portsmouth', sum: 650000, deductible: 1000, account: '40221187' },
      { key: 'aliceLapsed', number: 'HP-PRP-200001', holder: 'alice', type: 'PROPERTY', asset: 'Storage unit 22B, Quay Road', sum: 20000, deductible: 250, status: 'LAPSED', account: '40221187' },
      { key: 'benHealth', number: 'HP-HLT-300552', holder: 'ben', type: 'HEALTH', asset: 'Individual health plan — Gold', sum: 150000, deductible: 750, account: '55180342' },
      { key: 'benTravel', number: 'HP-TRV-400117', holder: 'ben', type: 'TRAVEL', asset: 'Annual multi-trip travel cover', sum: 25000, deductible: 100, account: '55180342', from: `${year}-03-01`, to: `${year + 1}-02-28` },
      { key: 'chenMotor', number: 'HP-MOT-100877', holder: 'chen', type: 'MOTOR', asset: '2021 Tesla Model 3 — plate CHW-2207', sum: 52000, deductible: 750, account: '77310000' },
      { key: 'chenLiability', number: 'HP-LIA-500091', holder: 'chen', type: 'LIABILITY', segment: 'COMMERCIAL', asset: 'Professional liability — Wei Design Studio', sum: 500000, deductible: 2500, account: '77314455', payeeType: 'BUSINESS' },
    ]
    const payees = {}
    const policies = {}
    for (const p of policySpecs) {
      const payeeKey = `${p.holder}:${p.account}`
      if (!payees[payeeKey]) {
        payees[payeeKey] = await t.insert('payees', {
          customer_id: users[p.holder].id,
          name: users[p.holder].full_name,
          payee_type: p.payeeType || 'INDIVIDUAL',
          bank_name: 'Harbor Community Bank (fictional)',
          bank_details_encrypted: crypto.encrypt(p.account),
          bank_last4: p.account.slice(-4),
          bank_details_hash: crypto.hash(p.account),
          verification_status: 'VERIFIED',
          verified_by: users.priya.id,
          verified_at: ago(90),
          sanctions_checked_at: ago(90),
          created_by: users.priya.id,
        })
      }
      policies[p.key] = await t.insert('policies', {
        external_policy_no: p.number,
        insured_id: users[p.holder].id,
        policy_type: p.type,
        segment: p.segment || 'PERSONAL',
        insured_name: users[p.holder].full_name,
        status: p.status || 'ACTIVE',
        effective_date: p.from || `${year}-01-01`,
        expiry_date: p.to || `${year}-12-31`,
        sum_insured: p.sum,
        deductible: p.deductible,
        premium: Math.round(p.sum * 0.018),
        insured_asset: p.asset,
        coverage_summary: `Fictional ${p.type.toLowerCase()} cover for demonstration purposes.`,
        coverages: [defaultCoverageLine(p.type)],
        limits: { sum_insured: p.sum },
        deductibles: { per_claim: p.deductible },
        payee_id: payees[payeeKey].id,
        source_system: 'POLICY_ADMIN',
        source_synced_at: ago(1),
      })
    }

    // ------------------------------------------------------------------ helpers
    const actorFor = (step, claim) => {
      const key = STEP_ACTOR[step]
      if (key === 'customer') return claim.customer_id
      if (key === 'adjuster') return claim.assigned_adjuster_id || users.adam.id
      return users[key].id
    }

    async function addClaim(spec) {
      const policy = policies[spec.policy]
      const customer = users[Object.keys(users).find((k) => users[k].id === policy.insured_id)]
      const draft = spec.status === 'DRAFT'
      const openedAt = draft ? null : ago(spec.ageDays)
      const steps = draft ? [] : ['SUBMITTED', ...(spec.path || PATHS[spec.status] || [])]
      const stepTimes = steps.map((_, i) => new Date(openedAt.getTime() + ((Date.now() - 2 * HOUR - openedAt.getTime()) * i) / Math.max(steps.length, 1)))
      const lastAt = stepTimes[stepTimes.length - 1] || new Date()
      const status = spec.finalStatus || steps[steps.length - 1] || 'DRAFT'
      const verified = steps.includes('DOCUMENT_REVIEW') || steps.includes('DOCUMENTS_REQUIRED') || spec.verified
      const clockStatus = status === 'ON_HOLD' ? spec.holdFrom : status
      const dueDate = STATUS_SLA_HOURS[clockStatus] ? new Date(lastAt.getTime() + STATUS_SLA_HOURS[clockStatus] * HOUR) : null
      const severity = draft ? null : spec.loss < 5000 ? 'LOW' : spec.loss < 50000 ? 'MEDIUM' : spec.loss < 200000 ? 'HIGH' : 'CATASTROPHIC'

      let claim = await t.insert('claims', {
        claim_number: draft ? null : spec.number,
        customer_id: customer.id,
        policy_id: policy.id,
        claim_type: policy.policy_type,
        segment: policy.segment,
        status,
        hold_from_status: spec.holdFrom || null,
        priority: spec.priority || 'MEDIUM',
        severity,
        complexity: draft ? null : spec.complexity || (spec.loss >= 50000 ? 3 : 1),
        insured_name: policy.insured_name,
        loss_date: draft ? ago(1) : new Date(openedAt.getTime() - (spec.lossLeadDays ?? 2) * DAY),
        loss_location: spec.location,
        loss_city: spec.city || 'Kochi',
        loss_country: spec.country || 'India',
        loss_type: spec.category,
        loss_description: spec.description,
        estimated_loss: spec.loss,
        affected_asset: spec.asset || policy.insured_asset,
        declaration_accepted: !draft,
        declaration_accepted_at: openedAt,
        draft_step: spec.draftStep || 6,
        opened_at: openedAt,
        assigned_owner_id: spec.owner ? users[spec.owner].id : steps.length > 1 ? users.olivia.id : null,
        assigned_adjuster_id: spec.adjuster ? users[spec.adjuster].id : null,
        assigned_reviewer_id: spec.reviewer ? users[spec.reviewer].id : null,
        due_date: dueDate,
        coverage_result: verified ? 'COVERED' : null,
        intake_checklist: verified ? fullChecklist(INTAKE_CHECKLIST, users.olivia) : spec.partialChecklist ? { POLICY_ACTIVE: { checked: true, by: users.olivia.id, by_name: users.olivia.full_name, at: ago(0, 3).toISOString() } } : {},
        rejection_reason: spec.rejectionReason || null,
        closure_reason: status === 'CLOSED' ? 'Settled and paid' : null,
        closed_at: status === 'CLOSED' ? lastAt : null,
        escalation_level: spec.escalation || 0,
        escalated_at: spec.escalation ? ago(1) : null,
        escalation_reason: spec.escalation ? spec.escalationReason : null,
        created_by: customer.id,
        created_at: openedAt ? new Date(openedAt.getTime() - HOUR) : ago(0, 5),
      })

      await t.insert('claim_parties', {
        claim_id: claim.id,
        party_type: 'CLAIMANT',
        name: customer.full_name,
        contact_encrypted: crypto.encryptJson({ email: customer.email, phone: customer.phone || '+91 98450 10100' }),
        role_in_loss: 'Claimant',
        is_payee_candidate: true,
        created_by: customer.id,
      })

      if (!draft) {
        const { payee_id: _payee, ...snapshot } = policy
        const snap = await t.insert('policy_snapshots', {
          claim_id: claim.id,
          policy_id: policy.id,
          policy_version: policy.version,
          snapshot,
          sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
          reason: 'FNOL',
          captured_by: customer.id,
          captured_at: openedAt,
        })
        claim = await t.updateById('claims', claim.id, { policy_snapshot_id: snap.id })
        await t.insert('consents', {
          subject_id: customer.id,
          claim_id: claim.id,
          consent_type: 'CLAIM_DECLARATION',
          notice_version: PRIVACY_NOTICE_VERSION,
          granted: true,
          recorded_at: openedAt,
        })
        await t.insert('sla_clocks', {
          claim_id: claim.id,
          clock_type: 'ACKNOWLEDGE',
          stage: 'SUBMITTED',
          segment: claim.segment,
          started_at: openedAt,
          due_at: new Date(openedAt.getTime() + 5 * 60_000),
          stopped_at: openedAt,
        })
        if (verified) {
          await t.insert('coverage_results', {
            claim_id: claim.id,
            snapshot_id: snap.id,
            result: 'COVERED',
            matched_perils: [spec.category],
            applied_limits: { sum_insured: policy.sum_insured },
            deductible: policy.deductible,
            notes: 'Policy active, loss type covered.',
            reviewed_by: users.olivia.id,
            created_at: stepTimes[1] || openedAt,
          })
        }
        // A running clock for the current stage; holds pause the held stage's clock.
        if (dueDate && !['CLOSED', 'REJECTED', 'WITHDRAWN'].includes(status)) {
          const waiting = ['DOCUMENTS_REQUIRED', 'ON_HOLD'].includes(status)
          await t.insert('sla_clocks', {
            claim_id: claim.id,
            clock_type: 'STAGE',
            stage: clockStatus,
            segment: claim.segment,
            started_at: lastAt,
            due_at: dueDate,
            paused_at: waiting ? lastAt : null,
            pause_reason: status === 'ON_HOLD' ? 'Claim on hold' : waiting ? 'Waiting on client' : null,
            breached_at: !waiting && dueDate < new Date() ? dueDate : null,
            escalation_level: !waiting && dueDate < new Date() ? 1 : 0,
          })
        }
      }

      let previous = 'DRAFT'
      for (let i = 0; i < steps.length; i += 1) {
        const to = steps[i]
        const visible = !(to === 'ON_HOLD' || previous === 'ON_HOLD') && CUSTOMER_STATUS_LABELS[previous] !== CUSTOMER_STATUS_LABELS[to]
        await t.insert('claim_status_history', {
          claim_id: claim.id,
          from_status: previous,
          to_status: to,
          changed_by: actorFor(to, claim),
          reason: spec.reasons?.[to] || null,
          customer_message: visible ? `Status updated: ${CUSTOMER_STATUS_LABELS[to]}.` : null,
          customer_visible: visible,
          created_at: stepTimes[i],
        })
        await t.insert('audit_logs', {
          actor_id: actorFor(to, claim),
          actor_type: 'USER',
          actor_roles: [],
          action: 'CLAIM_STATUS_CHANGED',
          entity_type: 'claim',
          entity_id: claim.id,
          claim_id: claim.id,
          after: { status: to },
          metadata: { from: previous, to, seed: true },
          occurred_at: stepTimes[i],
        })
        previous = to
      }

      if (claim.assigned_owner_id) await assign(claim, 'OPERATIONS_OWNER', claim.assigned_owner_id, stepTimes[1] || openedAt)
      if (claim.assigned_reviewer_id) await assign(claim, 'DOCUMENT_REVIEWER', claim.assigned_reviewer_id, stepTimes[2] || openedAt)
      if (claim.assigned_adjuster_id) await assign(claim, 'ADJUSTER', claim.assigned_adjuster_id, stepTimes[4] || openedAt)
      return { ...claim, stepTimes }
    }

    async function assign(claim, role, userId, at) {
      await t.insert('claim_assignments', {
        claim_id: claim.id,
        assignee_id: userId,
        assignment_role: role,
        // Owners are assigned by automatic intake routing (system), adjusters by a manager.
        assigned_by: role === 'ADJUSTER' ? users.maria.id : role === 'OPERATIONS_OWNER' ? null : users.olivia.id,
        reason: role === 'OPERATIONS_OWNER' ? 'Automatic intake routing' : null,
        assigned_at: at,
      })
    }

    /** Required-artifact rows for a submitted claim, in the state its documents imply. */
    async function addRequirements(claim, states = {}) {
      for (const docType of REQUIRED_DOCUMENTS[claim.claim_type]) {
        const state = states[docType] || { status: 'MISSING' }
        await t.insert('artifact_requirements', {
          claim_id: claim.id,
          requirement_type: 'DOCUMENT',
          doc_type: docType,
          is_required: true,
          status: state.status,
          document_id: state.document?.id || null,
          request_message: state.message || null,
          requested_by: state.message ? users.raj.id : null,
          requested_at: state.message ? ago(3) : null,
          due_at: state.message ? new Date(Date.now() + 4 * DAY) : null,
          received_at: state.document ? state.document.received_at : null,
          closed_at: state.status === 'ACCEPTED' ? ago(2) : null,
        })
      }
    }

    async function addDoc(claim, { docType, name, status = 'ACCEPTED', reviewer = 'raj', rejection, daysAgo = 3, uploadedBy }) {
      const id = randomUUID()
      const storageKey = `claims/${claim.id}/${id}.pdf`
      const pdf = buildSamplePdf([
        'HarborPoint General Insurance — SAMPLE DOCUMENT',
        'Fictional demonstration data. Not a real record.',
        `Claim: ${claim.claim_number || 'draft'}`,
        `Document type: ${docType}`,
        `File: ${name}`,
      ])
      files.push({ path: storageKey, buffer: pdf })
      const reviewed = status === 'ACCEPTED' || status === 'REJECTED'
      const sha = createHash('sha256').update(pdf).digest('hex')
      const doc = await t.insert('documents', {
        id,
        claim_id: claim.id,
        version: 1,
        doc_type: docType,
        file_name: name,
        storage_key: storageKey,
        mime_type: 'application/pdf',
        size_bytes: pdf.length,
        sha256: sha,
        source: 'WEB',
        status,
        uploaded_by: uploadedBy || claim.customer_id,
        received_at: ago(daysAgo),
        reviewer_id: reviewer ? users[reviewer].id : null,
        review_assigned_at: reviewer ? ago(daysAgo) : null,
        reviewed_by: reviewed ? users[reviewer].id : null,
        reviewed_at: reviewed ? ago(Math.max(daysAgo - 1, 0), 2) : null,
        review_comment: status === 'ACCEPTED' ? 'Legible and complete.' : null,
        rejection_reason: status === 'REJECTED' ? rejection : null,
      })
      await t.insert('document_versions', {
        document_id: id,
        version_no: 1,
        storage_key: storageKey,
        file_name: name,
        mime_type: 'application/pdf',
        size_bytes: pdf.length,
        sha256: sha,
        status,
        uploaded_by: doc.uploaded_by,
        uploaded_at: doc.received_at,
        reviewed_by: doc.reviewed_by,
        reviewed_at: doc.reviewed_at,
        rejection_reason: doc.rejection_reason,
      })
      return doc
    }

    const requiredDocs = {
      MOTOR: [['PROOF_OF_LOSS', 'proof-of-loss.pdf'], ['PHOTOS', 'damage-photos.pdf'], ['REPAIR_ESTIMATE', 'repair-estimate.pdf']],
      PROPERTY: [['PROOF_OF_LOSS', 'proof-of-loss.pdf'], ['PHOTOS', 'property-damage-photos.pdf']],
      HEALTH: [['MEDICAL_REPORT', 'discharge-summary.pdf'], ['INVOICE', 'hospital-invoice.pdf']],
      TRAVEL: [['PROOF_OF_LOSS', 'airline-report.pdf'], ['INVOICE', 'replacement-receipts.pdf']],
      LIABILITY: [['PROOF_OF_LOSS', 'third-party-claim-letter.pdf']],
    }
    const acceptRequired = async (claim, daysAgo = 8) => {
      const states = {}
      for (const [docType, name] of requiredDocs[claim.claim_type]) {
        states[docType] = { status: 'ACCEPTED', document: await addDoc(claim, { docType, name, daysAgo }) }
      }
      await addRequirements(claim, states)
    }

    async function addEvaluation(claim, { adjuster, status, version = 1, est, rec, decision = 'PAY_PARTIAL', findings, reviewedBy, comment, liability = null }) {
      return t.insert('evaluations', {
        claim_id: claim.id,
        version_no: version,
        adjuster_id: users[adjuster].id,
        status,
        checklist: status === 'DRAFT' ? { SITE_INSPECTION: true, STATEMENTS_COLLECTED: true } : Object.fromEntries(INVESTIGATION_CHECKLIST.map((i) => [i.key, true])),
        findings,
        evidence: [{ description: 'Site inspection photographs and adjuster notes' }],
        loss_value: est,
        liability_pct: liability,
        recommended_settlement: rec,
        decision,
        internal_notes: 'Seeded demo evaluation.',
        submitted_at: status === 'DRAFT' ? null : ago(4),
        reviewed_by: reviewedBy ? users[reviewedBy].id : null,
        reviewed_at: reviewedBy ? ago(3) : null,
        review_comment: comment || null,
      })
    }

    /**
     * Reserves follow the authority rule: within the adjuster's limit they are
     * posted directly, above it they wait for (or received) a manager review.
     */
    async function addReserve(claim, evaluation, { amount, review, decidedBy, comments }) {
      const reserve = await t.insert('reserves', {
        claim_id: claim.id,
        evaluation_id: evaluation.id,
        coverage_line: defaultCoverageLine(claim.claim_type),
        amount,
        reason_code: 'INITIAL',
        notes: 'Reserve per adjuster evaluation',
        set_by: evaluation.adjuster_id,
        created_by: evaluation.adjuster_id,
        authority_ok: !review,
        approval_status: !review ? 'POSTED' : decidedBy ? 'APPROVED' : 'PENDING_REVIEW',
        approved_by: decidedBy ? users[decidedBy].id : null,
        approved_at: decidedBy ? ago(3, 20) : null,
        review_comment: decidedBy ? comments || 'Reserve consistent with evaluation.' : null,
        effective_at: ago(4),
      })
      if (decidedBy) {
        await t.insert('reviews', {
          claim_id: claim.id,
          checkpoint_type: 'RESERVE',
          subject_type: 'reserve',
          subject_id: reserve.id,
          status: 'DECIDED',
          outcome: 'APPROVED',
          amount,
          requested_by: evaluation.adjuster_id,
          reviewer_id: users[decidedBy].id,
          decided_by: users[decidedBy].id,
          comments: comments || 'Reserve consistent with evaluation.',
          reviewed_at: ago(3, 20),
        })
      }
      return reserve
    }

    async function addCompliance(claim, { status, hold = false, flags = [], notes, decidedBy }) {
      const review = await t.insert('reviews', {
        claim_id: claim.id,
        checkpoint_type: 'COMPLIANCE',
        subject_type: 'claim',
        subject_id: claim.id,
        status,
        checklist: ['CLEARED', 'EXCEPTION_APPROVED'].includes(status) ? Object.fromEntries(COMPLIANCE_CHECKLIST.map((i) => [i.key, true])) : { SANCTIONS_SCREENING: status !== 'PENDING' },
        evidence: [],
        comments: notes || null,
        hold_active: hold,
        hold_placed_by: hold ? users.carlos.id : null,
        hold_placed_at: hold ? ago(1) : null,
        reviewer_id: status === 'PENDING' ? null : users.carlos.id,
        decided_by: decidedBy ? users[decidedBy].id : null,
        reviewed_at: decidedBy ? ago(2, 12) : null,
        created_by: users.maria.id,
        created_at: ago(2, 20),
      })
      for (const f of flags) {
        await t.insert('claim_fraud_flags', {
          claim_id: claim.id,
          code: f.code,
          severity: f.severity,
          contribution: f.contribution,
          note: f.note,
          resolved: false,
          review_id: review.id,
          created_by: users.carlos.id,
        })
      }
      return review
    }

    /** A settlement (payment row) with its approval step; decided steps are historical seed records. */
    async function addSettlement(claim, evaluation, policy, { amount, status, approvedBy, approverRole = 'OPS_MANAGER', attempts = [], reconciled = false }) {
      const paid = ['PAID', 'RECONCILED'].includes(status)
      const payment = await t.insert('payments', {
        claim_id: claim.id,
        evaluation_id: evaluation.id,
        payee_id: policy.payee_id,
        amount,
        status,
        method: 'EFT',
        provider: 'SIMULATED',
        is_simulated: true,
        requested_by: evaluation.adjuster_id,
        requested_at: ago(2, 10),
        approved_by: approvedBy ? users[approvedBy].id : null,
        approved_at: approvedBy ? ago(2) : null,
        notes: `Settlement per evaluation v${evaluation.version_no}`,
        portal_reference: attempts.find((a) => a.status === 'SUCCEEDED')?.ref || null,
        attempt_count: attempts.length,
        last_failure_reason: attempts.filter((a) => a.status === 'FAILED').pop()?.reason || null,
        block_reason: status === 'FAILED' ? attempts.filter((a) => a.status === 'FAILED').pop()?.reason : null,
        issued_at: paid ? ago(1, 4) : null,
        cleared_at: reconciled ? ago(1) : null,
        reconciled_by: reconciled ? users.paul.id : null,
        reconciliation_reference: reconciled ? 'RECON-SIM-0042' : null,
        created_by: users.carlos.id,
      })
      await t.insert('settlement_approval_steps', {
        payment_id: payment.id,
        step_no: 1,
        required_role: approverRole,
        approver_id: approvedBy ? users[approvedBy].id : null,
        approver_limit_at_decision: approvedBy ? users[approvedBy].limits?.settlement ?? ROLE_SETTLEMENT_LIMITS[approverRole] : null,
        status: approvedBy ? 'APPROVED' : 'PENDING',
        decided_at: approvedBy ? ago(2) : null,
        comment: approvedBy ? 'Settlement approved within authority.' : null,
      })
      let n = 0
      for (const a of attempts) {
        n += 1
        await t.insert('payment_attempts', {
          payment_id: payment.id,
          attempt_no: n,
          idempotency_key: `seed-${payment.id}-${n}`,
          status: a.status,
          provider: 'SIMULATED',
          provider_reference: a.ref || null,
          failure_code: a.code || null,
          failure_reason: a.reason || null,
          initiated_by: users.priya.id,
          started_at: ago(1, 5),
          completed_at: ago(1, 5),
          raw_response: { simulated: true, status: a.status },
        })
      }
      return payment
    }

    async function addTask(claim, { title, type = 'GENERAL', owner, role, dueInHours, blocking = false, status = 'OPEN', priority }) {
      return t.insert('tasks', {
        claim_id: claim?.id || null,
        title,
        type,
        status,
        priority: priority || claim?.priority || 'MEDIUM',
        blocking,
        owner_user_id: owner ? users[owner].id : null,
        owner_role: role || null,
        claimed_at: owner ? ago(1) : null,
        source_stage: claim?.stage || null,
        due_at: dueInHours == null ? null : new Date(Date.now() + dueInHours * HOUR),
        created_by: users.olivia.id,
        completed_at: status === 'DONE' ? ago(1) : null,
        completed_by: status === 'DONE' && owner ? users[owner].id : null,
      })
    }

    async function note(userKey, claim, type, title, message, daysAgo = 1, read = false) {
      const base = {
        recipient_id: users[userKey].id,
        claim_id: claim?.id || null,
        template: type,
        title,
        message,
        link: claim ? (users[userKey].roles.includes('CLIENT') ? `/customer/claims/${claim.id}` : `/claims/${claim.id}`) : null,
        created_at: ago(daysAgo),
        sent_at: ago(daysAgo),
      }
      await t.insert('notifications', { ...base, channel: 'IN_APP', status: read ? 'READ' : 'DELIVERED', read_at: read ? ago(daysAgo - 0.5) : null })
      await t.insert('notifications', { ...base, channel: 'EMAIL', status: 'LOGGED_DEV' })
    }

    // ------------------------------------------------------------------ claims
    const c = {}

    c.draft = await addClaim({
      status: 'DRAFT', policy: 'aliceMotor', draftStep: 3, category: 'WINDSCREEN', loss: 650,
      location: 'I-95 northbound near exit 7', description: 'Stone chip cracked the windscreen while driving on the highway.',
    })

    c.submitted = await addClaim({
      status: 'SUBMITTED', number: 'HPC-2026-000101', policy: 'benHealth', ageDays: 0.25, category: 'OUTPATIENT', loss: 2400, priority: 'LOW', owner: 'omar',
      location: 'Riverside Medical Clinic', description: 'Outpatient treatment for a fractured wrist after a fall at home, including X-rays and casting.',
    })
    await addRequirements(c.submitted)
    await addTask(c.submitted, { title: 'Intake review for HPC-2026-000101', type: 'INTAKE_REVIEW', owner: 'omar', role: 'CLAIMS_OPS_MANAGER', dueInHours: 18, blocking: true })

    c.verification = await addClaim({
      status: 'POLICY_VERIFICATION', number: 'HPC-2026-000102', policy: 'chenLiability', ageDays: 1.5, category: 'THIRD_PARTY_PROPERTY', loss: 18500,
      priority: 'HIGH', owner: 'olivia', partialChecklist: true,
      location: 'Client office, 88 Market Street', description: 'Installation error during a studio fit-out damaged the client’s flooring and custom cabinetry.',
    })
    await addRequirements(c.verification)
    await addTask(c.verification, { title: 'Intake review for HPC-2026-000102', type: 'INTAKE_REVIEW', owner: 'olivia', role: 'CLAIMS_OPS_MANAGER', dueInHours: -4, blocking: true })

    c.docsRequired = await addClaim({
      status: 'DOCUMENTS_REQUIRED', number: 'HPC-2026-000103', policy: 'aliceHome', ageDays: 6, category: 'WATER_DAMAGE', loss: 12800, reviewer: 'raj',
      location: '14 Harbor View Lane, Portsmouth', description: 'Burst pipe in the upstairs bathroom flooded the kitchen ceiling and damaged cabinets and flooring.',
      reasons: { DOCUMENTS_REQUIRED: 'Photos rejected: images too dark to assess the damage' },
    })
    {
      const proof = await addDoc(c.docsRequired, { docType: 'PROOF_OF_LOSS', name: 'plumber-report.pdf', daysAgo: 5 })
      const photos = await addDoc(c.docsRequired, { docType: 'PHOTOS', name: 'kitchen-ceiling-photos.pdf', status: 'REJECTED', rejection: 'Images too dark to assess the damage', daysAgo: 5 })
      await addRequirements(c.docsRequired, {
        PROOF_OF_LOSS: { status: 'ACCEPTED', document: proof },
        PHOTOS: { status: 'REQUESTED', document: photos, message: 'Please upload replacement photos: images too dark to assess the damage' },
      })
      await t.insert('artifact_requirements', {
        claim_id: c.docsRequired.id, requirement_type: 'INFORMATION', status: 'REQUESTED',
        request_message: 'When was the plumbing last serviced? Please share the approximate date.',
        requested_by: users.olivia.id, requested_at: ago(3), due_at: new Date(Date.now() + 4 * DAY),
      })
    }
    await addTask(c.docsRequired, { title: 'Follow up rejected Photos: kitchen-ceiling-photos.pdf', type: 'DOCUMENT_FOLLOW_UP', owner: 'raj', role: 'DOCUMENT_REVIEWER', dueInHours: 96 })

    c.docReview = await addClaim({
      status: 'DOCUMENT_REVIEW', number: 'HPC-2026-000104', policy: 'benHealth', ageDays: 3, category: 'HOSPITALISATION', loss: 9600, reviewer: 'raj',
      location: 'St. Anne’s Hospital', description: 'Two-night hospital stay for acute appendicitis with laparoscopic appendectomy.',
    })
    {
      const report = await addDoc(c.docReview, { docType: 'MEDICAL_REPORT', name: 'discharge-summary.pdf', status: 'PENDING_REVIEW', daysAgo: 2 })
      const invoice = await addDoc(c.docReview, { docType: 'INVOICE', name: 'hospital-invoice.pdf', status: 'PENDING_REVIEW', daysAgo: 2 })
      await addRequirements(c.docReview, { MEDICAL_REPORT: { status: 'RECEIVED', document: report }, INVOICE: { status: 'RECEIVED', document: invoice } })
    }

    c.adjAssign = await addClaim({
      status: 'ADJUSTER_ASSIGNMENT', number: 'HPC-2026-000105', policy: 'chenMotor', ageDays: 5, category: 'COLLISION', loss: 6900, reviewer: 'raj',
      location: 'Car park, Westfield Mall', description: 'Another vehicle reversed into the rear passenger door while parked; the other driver left contact details.',
    })
    await acceptRequired(c.adjAssign, 4)
    await addTask(c.adjAssign, { title: 'Assign an adjuster to HPC-2026-000105', type: 'ASSIGN_ADJUSTER', owner: 'olivia', role: 'CLAIMS_OPS_MANAGER', dueInHours: -6, blocking: true })

    c.investigation = await addClaim({
      status: 'INVESTIGATION', number: 'HPC-2026-000106', policy: 'aliceMotor', ageDays: 9, category: 'THEFT', loss: 3100, reviewer: 'raj', adjuster: 'adam',
      location: 'Residential street outside 14 Harbor View Lane', description: 'Vehicle broken into overnight; dashboard camera, sunglasses and a laptop bag were stolen.',
    })
    await acceptRequired(c.investigation, 8)
    await addDoc(c.investigation, { docType: 'POLICE_REPORT', name: 'police-report-PR-55812.pdf', daysAgo: 7 })
    await addEvaluation(c.investigation, { adjuster: 'adam', status: 'DRAFT', est: 2850, rec: 2350, findings: 'Police report confirms forced entry. Awaiting receipts for the laptop bag.' })
    await addTask(c.investigation, { title: 'Investigate claim HPC-2026-000106', type: 'INVESTIGATION', owner: 'adam', role: 'ADJUSTER', dueInHours: 120, blocking: true })

    c.reserveSmall = await addClaim({
      status: 'RESERVE_APPROVAL', number: 'HPC-2026-000107', policy: 'benHealth', ageDays: 14, category: 'SURGERY', loss: 21000, priority: 'HIGH', reviewer: 'raj', adjuster: 'amara',
      location: 'Lakeside Orthopaedic Centre', description: 'Knee arthroscopy following a sports injury, with physiotherapy sessions afterwards.',
    })
    await acceptRequired(c.reserveSmall, 12)
    {
      const e = await addEvaluation(c.reserveSmall, { adjuster: 'amara', status: 'SUBMITTED', est: 19800, rec: 18500, findings: 'Treatment medically necessary per surgeon’s notes; two physiotherapy sessions exceed plan limits and are excluded.' })
      await addReserve(c.reserveSmall, e, { amount: 18500, review: true })
    }

    c.reserveLarge = await addClaim({
      status: 'RESERVE_APPROVAL', number: 'HPC-2026-000108', policy: 'chenLiability', ageDays: 20, category: 'THIRD_PARTY_INJURY', loss: 145000, priority: 'URGENT', reviewer: 'raj', adjuster: 'adam',
      escalation: 1, escalationReason: 'High-value bodily injury claim; legal counsel engaged by third party.', complexity: 4,
      location: 'Wei Design Studio showroom', description: 'A visitor tripped over an unsecured display platform in the showroom and fractured an ankle.',
    })
    await acceptRequired(c.reserveLarge, 18)
    {
      const e = await addEvaluation(c.reserveLarge, { adjuster: 'adam', status: 'SUBMITTED', est: 132000, rec: 120000, liability: 100, findings: 'Liability accepted. Medical costs and lost earnings substantiated; general damages estimated from comparable cases.' })
      await addReserve(c.reserveLarge, e, { amount: 120000, review: true })
    }

    c.complianceHold = await addClaim({
      status: 'COMPLIANCE_REVIEW', number: 'HPC-2026-000109', policy: 'aliceHome', ageDays: 25, category: 'STORM', loss: 38500, priority: 'HIGH', reviewer: 'raj', adjuster: 'amara',
      path: [...PATHS.RESERVE_APPROVAL, 'COMPLIANCE_REVIEW'],
      location: '14 Harbor View Lane, Portsmouth', description: 'Storm winds removed roof tiles; rainwater damaged the loft insulation and bedroom ceilings.',
    })
    await acceptRequired(c.complianceHold, 22)
    {
      const e = await addEvaluation(c.complianceHold, { adjuster: 'amara', status: 'APPROVED', est: 36200, rec: 34900, findings: 'Roofing contractor estimate verified; storm event confirmed by regional weather data.', reviewedBy: 'maria' })
      await addReserve(c.complianceHold, e, { amount: 36000, review: true, decidedBy: 'maria' })
      await addCompliance(c.complianceHold, {
        status: 'HOLD', hold: true,
        flags: [{ code: 'SANCTIONS_MATCH', severity: 'HIGH', contribution: 60, note: 'Roofing contractor name is a partial match on a watch list; verification requested.' }],
        notes: 'Payee contractor partially matches a sanctions watch list entry. Hold until verified.',
      })
    }
    await addTask(c.complianceHold, { title: 'Verify contractor identity against sanctions list', type: 'COMPLIANCE', owner: 'carlos', role: 'COMPLIANCE_SECURITY', dueInHours: 24, blocking: true })

    c.complianceClean = await addClaim({
      status: 'COMPLIANCE_REVIEW', number: 'HPC-2026-000110', policy: 'benTravel', ageDays: 16, category: 'LOST_BAGGAGE', loss: 1850, priority: 'LOW', reviewer: 'raj', adjuster: 'amara',
      location: 'Lisbon Airport, Portugal', description: 'Checked suitcase was not delivered on arrival and was declared lost by the airline after 21 days.',
    })
    await acceptRequired(c.complianceClean, 14)
    {
      const e = await addEvaluation(c.complianceClean, { adjuster: 'amara', status: 'SUBMITTED', est: 1850, rec: 1600, findings: 'Airline property irregularity report verified. Depreciation applied to clothing items.' })
      await addReserve(c.complianceClean, e, { amount: 1700 })
      await addCompliance(c.complianceClean, { status: 'PENDING' })
    }

    c.settlement = await addClaim({
      status: 'SETTLEMENT_APPROVAL', number: 'HPC-2026-000111', policy: 'aliceMotor', ageDays: 22, category: 'VANDALISM', loss: 8400, reviewer: 'raj', adjuster: 'adam',
      location: 'Office parking garage, Level 2', description: 'Vehicle paintwork scratched along both sides and a wing mirror broken while parked overnight.',
    })
    await acceptRequired(c.settlement, 20)
    {
      const e = await addEvaluation(c.settlement, { adjuster: 'adam', status: 'SUBMITTED', est: 8100, rec: 7800, findings: 'Bodyshop estimate reasonable; deductible applied.' })
      await addReserve(c.settlement, e, { amount: 8000 })
      await addCompliance(c.settlement, { status: 'CLEARED', decidedBy: 'carlos', notes: 'All screening checks passed.' })
      // 7,800 is within the assigned adjuster's personal-segment settlement authority.
      await addSettlement(c.settlement, e, policies.aliceMotor, { amount: 7800, status: 'PENDING_APPROVAL', approverRole: 'ADJUSTER' })
    }

    c.paymentPending = await addClaim({
      status: 'PAYMENT_PENDING', number: 'HPC-2026-000112', policy: 'aliceMotor', ageDays: 28, category: 'COLLISION', loss: 5200, reviewer: 'raj', adjuster: 'adam',
      location: 'Junction of Pier Road and Elm Street', description: 'Low-speed collision at a junction; front bumper and headlight damaged. Third party admitted fault.',
    })
    await acceptRequired(c.paymentPending, 26)
    {
      const e = await addEvaluation(c.paymentPending, { adjuster: 'adam', status: 'SUBMITTED', est: 4900, rec: 4400, findings: 'Repair estimate verified with approved garage; deductible applied.', liability: 0 })
      await addReserve(c.paymentPending, e, { amount: 4600 })
      await addCompliance(c.paymentPending, { status: 'CLEARED', decidedBy: 'carlos' })
      await addSettlement(c.paymentPending, e, policies.aliceMotor, { amount: 4400, status: 'PENDING', approvedBy: 'adam', approverRole: 'ADJUSTER' })
    }

    c.paymentFailed = await addClaim({
      status: 'PAYMENT_FAILED', number: 'HPC-2026-000113', policy: 'chenMotor', ageDays: 30, category: 'WINDSCREEN', loss: 1450, priority: 'MEDIUM', reviewer: 'raj', adjuster: 'amara',
      location: 'Route 1 southbound', description: 'Windscreen shattered by debris from a truck; replaced at an approved glass repairer.',
    })
    await acceptRequired(c.paymentFailed, 28)
    {
      const e = await addEvaluation(c.paymentFailed, { adjuster: 'amara', status: 'SUBMITTED', est: 1450, rec: 1200, decision: 'PAY_PARTIAL', findings: 'Glass invoice verified; deductible applied.' })
      await addReserve(c.paymentFailed, e, { amount: 1300 })
      await addCompliance(c.paymentFailed, { status: 'CLEARED', decidedBy: 'carlos' })
      const p = await addSettlement(c.paymentFailed, e, policies.chenMotor, {
        amount: 1200, status: 'FAILED', approvedBy: 'amara', approverRole: 'ADJUSTER',
        attempts: [{ status: 'FAILED', code: 'ACCOUNT_CLOSED', reason: 'Simulated: beneficiary account is closed' }],
      })
      const task = await addTask(c.paymentFailed, { title: 'Obtain updated bank details from claimant', type: 'PAYMENT_BLOCK', owner: 'priya', role: 'PAYMENT_OPERATOR', dueInHours: 20, blocking: true, priority: 'HIGH' })
      await t.insert('payment_blocks', { payment_id: p.id, block_type: 'PAYMENT_FAILED', detail: 'Simulated: beneficiary account is closed', opened_by: users.priya.id, owner_task_id: task.id, opened_at: ago(1, 5) })
    }

    c.paid = await addClaim({
      status: 'PAID', number: 'HPC-2026-000114', policy: 'benTravel', ageDays: 35, category: 'TRIP_CANCELLATION', loss: 3200, reviewer: 'raj', adjuster: 'amara',
      location: 'Home — trip to Kyoto, Japan', description: 'Trip cancelled two days before departure due to hospitalisation of an immediate family member.',
    })
    await acceptRequired(c.paid, 33)
    {
      const e = await addEvaluation(c.paid, { adjuster: 'amara', status: 'SUBMITTED', est: 3200, rec: 3100, decision: 'PAY_FULL', findings: 'Non-refundable bookings verified; medical certificate supports cancellation.' })
      const r = await addReserve(c.paid, e, { amount: 3100 })
      await addCompliance(c.paid, { status: 'CLEARED', decidedBy: 'carlos' })
      await addSettlement(c.paid, e, policies.benTravel, { amount: 3100, status: 'PAID', approvedBy: 'amara', approverRole: 'ADJUSTER', attempts: [{ status: 'SUCCEEDED', ref: 'SIM-TXN-7F3A91C2D4E8' }] })
      // The reserve was reduced when the payment was issued.
      await t.updateById('reserves', r.id, { approval_status: 'SUPERSEDED' })
      await t.insert('reserves', { claim_id: c.paid.id, evaluation_id: e.id, coverage_line: r.coverage_line, amount: 0, prev_amount: 3100, reason_code: 'PAYMENT_ISSUED', notes: 'Reduced by issued payment of 3100.00', set_by: users.priya.id, created_by: users.priya.id, authority_ok: true, approval_status: 'POSTED', effective_at: ago(1, 4) })
    }
    await t.insert('recoveries', {
      claim_id: c.paid.id, type: 'SUBROGATION', target_party: 'Tour operator (fictional)', description: 'Partial refund owed by the tour operator for unused excursions.',
      expected_amount: 450, status: 'REFERRED', deadline: new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10), created_by: users.amara.id, updated_by: users.amara.id,
    })
    await t.insert('closure_requests', { claim_id: c.paid.id, requested_by: users.amara.id, reason: 'Payment issued and confirmed; subrogation referral handed to recoveries.' })

    c.closed = await addClaim({
      status: 'CLOSED', number: 'HPC-2026-000115', policy: 'aliceHome', ageDays: 60, category: 'ACCIDENTAL_DAMAGE', loss: 2100, priority: 'LOW', reviewer: 'raj', adjuster: 'adam',
      location: '14 Harbor View Lane, Portsmouth', description: 'Television knocked off its stand during furniture moving; screen cracked beyond repair.',
    })
    await acceptRequired(c.closed, 58)
    {
      const e = await addEvaluation(c.closed, { adjuster: 'adam', status: 'SUBMITTED', est: 1900, rec: 1100, findings: 'Like-for-like replacement value less deductible.' })
      const r = await addReserve(c.closed, e, { amount: 1100 })
      await addCompliance(c.closed, { status: 'CLEARED', decidedBy: 'carlos' })
      await addSettlement(c.closed, e, policies.aliceHome, { amount: 1100, status: 'RECONCILED', approvedBy: 'adam', approverRole: 'ADJUSTER', attempts: [{ status: 'SUCCEEDED', ref: 'SIM-TXN-2B9D44A0F1C7' }], reconciled: true })
      await t.updateById('reserves', r.id, { approval_status: 'SUPERSEDED' })
      await t.insert('reserves', { claim_id: c.closed.id, evaluation_id: e.id, coverage_line: r.coverage_line, amount: 0, prev_amount: 1100, reason_code: 'PAYMENT_ISSUED', notes: 'Reduced by issued payment of 1100.00', set_by: users.priya.id, created_by: users.priya.id, authority_ok: true, approval_status: 'POSTED', effective_at: ago(30) })
    }

    c.rejected = await addClaim({
      status: 'REJECTED', number: 'HPC-2026-000116', policy: 'benHealth', ageDays: 18, category: 'EMERGENCY', loss: 4800, path: ['POLICY_VERIFICATION', 'REJECTED'],
      rejectionReason: 'Treatment relates to a pre-existing condition excluded under section 4.2 of the policy.',
      reasons: { REJECTED: 'Pre-existing condition exclusion (section 4.2).' },
      location: 'City General A&E', description: 'Emergency visit for chest pain; diagnosed as a flare-up of a long-standing condition.',
    })

    c.onHold = await addClaim({
      status: 'ON_HOLD', number: 'HPC-2026-000117', policy: 'chenLiability', ageDays: 12, category: 'PROFESSIONAL_ERROR', loss: 26000, priority: 'HIGH',
      reviewer: 'raj', adjuster: 'amara', path: [...PATHS.INVESTIGATION, 'ON_HOLD'], holdFrom: 'INVESTIGATION',
      reasons: { ON_HOLD: 'Awaiting court filing from third party before assessment can continue.' },
      location: 'Client project — Harbor Lofts', description: 'Client alleges design specification error caused rework costs on a residential conversion project.',
    })
    await acceptRequired(c.onHold, 10)

    c.withdrawn = await addClaim({
      status: 'WITHDRAWN', number: 'HPC-2026-000118', policy: 'aliceMotor', ageDays: 40, category: 'WEATHER', loss: 900, priority: 'LOW', path: ['WITHDRAWN'],
      reasons: { WITHDRAWN: 'Damage repaired privately; no longer wish to claim.' },
      location: 'Driveway, 14 Harbor View Lane', description: 'Hailstones dented the bonnet and roof during a summer storm.',
    })

    // ------------------------------------------------------------------ integrations (pipeline history for the Data Engineer)
    for (const [source, days, records, failed, status] of [
      ['POLICY_ADMIN', 1, 7, 0, 'SUCCEEDED'],
      ['DOCUMENT_MANAGEMENT', 1, 32, 0, 'SUCCEEDED'],
      ['LEGACY_CLAIMS', 2, 18, 2, 'PARTIAL'],
    ]) {
      await t.insert('integration_sync_runs', {
        source_system: source, started_at: ago(days), finished_at: ago(days, -0.1), records_in: records, records_failed: failed, status,
        checkpoint: `seed-${source.toLowerCase()}`, error: failed ? `${failed} records could not be matched to a Hub claim` : null, triggered_by: users.dana.id,
      })
    }
    await t.insert('claim_xref', { claim_id: c.closed.id, source_system: 'LEGACY_CLAIMS', external_claim_id: 'LGC-88213', match_method: 'EXACT', match_confidence: 1, status: 'LINKED', last_synced_at: ago(2) })

    // ------------------------------------------------------------------ notifications & extra tasks
    await note('alice', c.docsRequired, 'DOCUMENT_REJECTED', 'Document needs attention: kitchen-ceiling-photos.pdf', 'Your photos for claim HPC-2026-000103 were not accepted: images too dark to assess the damage. Please upload a replacement.', 3)
    await note('alice', c.paymentPending, 'APPROVAL_DECISION', 'Claim HPC-2026-000112: Payment processing', 'Your settlement has been approved and payment is being processed.', 2)
    await note('alice', c.closed, 'CLAIM_CLOSED', 'Claim HPC-2026-000115: Closed', 'Your claim has been closed.', 20, true)
    await note('ben', c.paid, 'PAYMENT_SUCCEEDED', 'Claim HPC-2026-000114: Paid', 'Your settlement payment has been completed. (Simulated payment — demo data.)', 1)
    await note('ben', c.rejected, 'CLAIM_STATUS_CHANGED', 'Claim HPC-2026-000116: Not approved', 'Your claim could not be approved. Pre-existing condition exclusion (section 4.2).', 6, true)
    await note('chen', c.paymentFailed, 'PAYMENT_FAILED', 'Claim HPC-2026-000113: Payment delayed', 'There was a delay processing your payment. Our team is working on it.', 1)
    await note('olivia', c.verification, 'CLAIM_ASSIGNED', 'Claim HPC-2026-000102 assigned to you', 'You have been assigned as operations owner for claim HPC-2026-000102.', 1)
    await note('olivia', c.verification, 'TASK_OVERDUE', 'Overdue task: Intake review for HPC-2026-000102', 'The intake review task is overdue.', 0.1)
    await note('raj', c.docReview, 'TASK_ASSIGNED', 'New documents on HPC-2026-000104', 'Medical report and invoice uploaded and awaiting review.', 2)
    await note('adam', c.investigation, 'CLAIM_ASSIGNED', 'Claim HPC-2026-000106 assigned to you', 'You have been assigned as adjuster for claim HPC-2026-000106.', 5)
    await note('maria', c.reserveSmall, 'APPROVAL_REQUIRED', 'Reserve review required: HPC-2026-000107', 'Reserve of 18500.00 exceeds the adjuster’s authority.', 1)
    await note('maria', c.reserveLarge, 'APPROVAL_REQUIRED', 'Reserve review required: HPC-2026-000108', 'Reserve of 120000.00 requested by Adam Brooks. Exceeds your authority — refer to a senior manager.', 1)
    await note('sam', c.reserveLarge, 'APPROVAL_REQUIRED', 'Reserve review required: HPC-2026-000108', 'Reserve of 120000.00 requested by Adam Brooks.', 1)
    await note('maria', c.complianceHold, 'COMPLIANCE_HOLD', 'Compliance hold: HPC-2026-000109', 'A compliance hold blocks settlement and payment until cleared.', 1)
    await note('carlos', c.complianceClean, 'APPROVAL_REQUIRED', 'Compliance review required: HPC-2026-000110', 'Claim HPC-2026-000110 is ready for compliance review.', 2)
    await note('priya', c.settlement, 'APPROVAL_REQUIRED', 'Settlement approval required: HPC-2026-000111', 'Settlement of 7800.00 is within Payment Operator authority.', 1)
    await note('priya', c.paymentPending, 'APPROVAL_DECISION', 'Payment ready: HPC-2026-000112', 'Approved settlement of 4400.00 is awaiting issuance.', 2)
    await note('priya', c.paymentFailed, 'PAYMENT_FAILED', 'Payment failed: HPC-2026-000113', 'Simulated: beneficiary account is closed', 1)
    await note('maria', c.paid, 'APPROVAL_REQUIRED', 'Closure requested: HPC-2026-000114', 'Payment issued and confirmed; subrogation referral handed to recoveries.', 0.5)

    await addTask(null, { title: 'Prepare weekly claims aging summary', owner: 'olivia', role: 'CLAIMS_OPS_MANAGER', dueInHours: 48, priority: 'LOW' })
    await addTask(c.reserveLarge, { title: 'Review legal counsel correspondence', type: 'GENERAL', owner: 'sam', role: 'OPS_MANAGER', dueInHours: -20, priority: 'URGENT' })
    await addTask(c.closed, { title: 'Send settlement confirmation letter', type: 'GENERAL', owner: 'olivia', role: 'CLAIMS_OPS_MANAGER', status: 'DONE', dueInHours: -400 })

    await t.insert('audit_logs', {
      actor_id: users.dana.id,
      actor_type: 'USER',
      actor_roles: ['DATA_ENGINEER'],
      action: 'DEMO_DATA_SEEDED',
      entity_type: 'system',
      metadata: { claims: Object.keys(c).length, fictional: true },
    })

    return { users: DEMO_USERS.length, policies: policySpecs.length, claims: Object.keys(c).length }
  })

  for (const f of files) await storage.put(f.path, f.buffer, 'application/pdf')
  log(`demo data seeded: ${result.claims} claims, ${files.length} placeholder documents`)
  return result
}
