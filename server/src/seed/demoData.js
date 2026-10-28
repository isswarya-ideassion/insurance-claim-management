import { randomUUID, createHash } from 'node:crypto'
import { CUSTOMER_STATUS_LABELS, INTAKE_CHECKLIST, INVESTIGATION_CHECKLIST, COMPLIANCE_CHECKLIST } from '../../../shared/constants.js'
import { STATUS_SLA_HOURS } from '../../../shared/workflow.js'
import { buildSamplePdf } from './samplePdf.js'

/**
 * FICTIONAL DEMO DATA. All people, policies and claims are invented.
 * Used by mock mode (first start) and by scripts/provision-dev.js for a
 * development Supabase project. Users are always created through the
 * authentication provider first; profiles come from the auth trigger.
 */
export const DEMO_DOMAIN = 'demo.harborpoint.test'

export const DEMO_USERS = [
  { key: 'alice', email: `customer.alice@${DEMO_DOMAIN}`, fullName: 'Alice Thornton', phone: '+1 555 0101', roles: ['CUSTOMER'] },
  { key: 'ben', email: `customer.ben@${DEMO_DOMAIN}`, fullName: 'Benjamin Okafor', phone: '+1 555 0102', roles: ['CUSTOMER'] },
  { key: 'chen', email: `customer.chen@${DEMO_DOMAIN}`, fullName: 'Chen Wei', phone: '+1 555 0103', roles: ['CUSTOMER'] },
  { key: 'olivia', email: `ops.olivia@${DEMO_DOMAIN}`, fullName: 'Olivia Martins', roles: ['CLAIMS_OPERATIONS'] },
  { key: 'raj', email: `reviewer.raj@${DEMO_DOMAIN}`, fullName: 'Raj Patel', roles: ['DOCUMENT_REVIEWER'] },
  { key: 'adam', email: `adjuster.adam@${DEMO_DOMAIN}`, fullName: 'Adam Brooks', roles: ['CLAIMS_ADJUSTER'] },
  { key: 'amara', email: `adjuster.amara@${DEMO_DOMAIN}`, fullName: 'Amara Nwosu', roles: ['CLAIMS_ADJUSTER'] },
  { key: 'maria', email: `manager.maria@${DEMO_DOMAIN}`, fullName: 'Maria Gonzalez', roles: ['CLAIMS_MANAGER'], approvalLimit: 50000 },
  { key: 'sam', email: `manager.sam@${DEMO_DOMAIN}`, fullName: 'Samuel Reed', roles: ['CLAIMS_MANAGER', 'CLAIMS_OPERATIONS'], approvalLimit: 250000 },
  { key: 'priya', email: `payments.priya@${DEMO_DOMAIN}`, fullName: 'Priya Raman', roles: ['PAYMENT_OPERATIONS'] },
  { key: 'carlos', email: `compliance.carlos@${DEMO_DOMAIN}`, fullName: 'Carlos Mendes', roles: ['COMPLIANCE_OFFICER'] },
  { key: 'dana', email: `admin.dana@${DEMO_DOMAIN}`, fullName: 'Dana Kowalski', roles: ['DATA_ADMIN'] },
  { key: 'ade', email: `auditor.ade@${DEMO_DOMAIN}`, fullName: 'Adebayo Lawal', roles: ['AUDITOR'] },
  { key: 'rosa', email: `records.rosa@${DEMO_DOMAIN}`, fullName: 'Rosa Lindqvist', roles: ['CUSTOMER_RECORDS_ADMIN'] },
]

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
PATHS.COMPLIANCE_REVIEW = [...PATHS.RESERVE_APPROVAL, 'COMPLIANCE_REVIEW']
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
  COMPLIANCE_REVIEW: 'maria',
  SETTLEMENT_APPROVAL: 'carlos',
  PAYMENT_PENDING: 'maria',
  PAYMENT_FAILED: 'priya',
  PAID: 'priya',
  CLOSED: 'olivia',
  REJECTED: 'maria',
  WITHDRAWN: 'customer',
  ON_HOLD: 'olivia',
}

const fullChecklist = (items, who) =>
  Object.fromEntries(items.map((i) => [i.key, { checked: true, by: who.id, by_name: who.full_name, at: ago(5).toISOString() }]))

export async function demoDataExists(db) {
  const rows = await db.query('select count(*)::int as count from public.profiles where email like $1', [`%@${DEMO_DOMAIN}`])
  return rows[0].count > 0
}

/**
 * @param {object}   opts
 * @param {object}   opts.db          repository (seed runs in one transaction)
 * @param {object}   opts.storage     storage adapter for placeholder documents
 * @param {Function} opts.createUser  ({ email, password, fullName, phone, staff }) => { id }
 * @param {string}   opts.password    password for every demo account
 */
/** Creates any demo accounts missing from an existing demo database and grants their roles. */
export async function ensureDemoUsers({ db, createUser, password, log = () => {} }) {
  for (const u of DEMO_USERS) {
    if (await db.findOne('profiles', { email: u.email })) continue
    const created = await createUser({ email: u.email, password, fullName: u.fullName, phone: u.phone, staff: !u.roles.includes('CUSTOMER') })
    for (const role of u.roles) {
      await db.query(
        `insert into public.user_roles (user_id, role_code, approval_limit) values ($1, $2, $3) on conflict (user_id, role_code) do nothing`,
        [created.id, role, role === 'CLAIMS_MANAGER' ? u.approvalLimit : null],
      )
    }
    log(`added demo user ${u.email}`)
  }
}

export async function seedDemoData({ db, storage, createUser, password, log = () => {} }) {
  const users = {}
  for (const u of DEMO_USERS) {
    const existing = await db.findOne('profiles', { email: u.email })
    const created = existing || (await createUser({ email: u.email, password, fullName: u.fullName, phone: u.phone, staff: !u.roles.includes('CUSTOMER') }))
    users[u.key] = { ...u, id: created.id, full_name: u.fullName }
  }
  log(`demo users ready (${DEMO_USERS.length})`)

  const files = []
  const result = await db.tx(async (t) => {
    await t.query(`select set_config('app.seed_mode', 'on', true)`)

    for (const u of DEMO_USERS) {
      await t.update('profiles', { id: users[u.key].id }, { full_name: u.fullName, phone: u.phone || null })
      for (const role of u.roles) {
        await t.query(
          `insert into public.user_roles (user_id, role_code, approval_limit) values ($1, $2, $3)
           on conflict (user_id, role_code) do update set approval_limit = excluded.approval_limit`,
          [users[u.key].id, role, role === 'CLAIMS_MANAGER' ? u.approvalLimit : null],
        )
      }
    }

    // ------------------------------------------------------------------ policies
    const year = new Date().getUTCFullYear()
    const policySpecs = [
      { key: 'aliceMotor', number: 'HP-MOT-100231', holder: 'alice', type: 'MOTOR', asset: '2023 Volvo XC40 — plate HPT-4821', sum: 45000, deductible: 500, account: '40221187' },
      { key: 'aliceHome', number: 'HP-PRP-200418', holder: 'alice', type: 'PROPERTY', asset: '14 Harbor View Lane, Portsmouth', sum: 650000, deductible: 1000, account: '40221187' },
      { key: 'aliceLapsed', number: 'HP-PRP-200001', holder: 'alice', type: 'PROPERTY', asset: 'Storage unit 22B, Quay Road', sum: 20000, deductible: 250, status: 'LAPSED', account: '40221187' },
      { key: 'benHealth', number: 'HP-HLT-300552', holder: 'ben', type: 'HEALTH', asset: 'Individual health plan — Gold', sum: 150000, deductible: 750, account: '55180342' },
      { key: 'benTravel', number: 'HP-TRV-400117', holder: 'ben', type: 'TRAVEL', asset: 'Annual multi-trip travel cover', sum: 25000, deductible: 100, account: '55180342', from: `${year}-03-01`, to: `${year + 1}-02-28` },
      { key: 'chenMotor', number: 'HP-MOT-100877', holder: 'chen', type: 'MOTOR', asset: '2021 Tesla Model 3 — plate CHW-2207', sum: 52000, deductible: 750, account: '77310000' },
      { key: 'chenLiability', number: 'HP-LIA-500091', holder: 'chen', type: 'LIABILITY', asset: 'Professional liability — Wei Design Studio', sum: 500000, deductible: 2500, account: '77314455' },
    ]
    const policies = {}
    for (const p of policySpecs) {
      policies[p.key] = await t.insert('policies', {
        policy_number: p.number,
        holder_id: users[p.holder].id,
        policy_type: p.type,
        insured_name: users[p.holder].full_name,
        status: p.status || 'ACTIVE',
        effective_from: p.from || `${year}-01-01`,
        effective_to: p.to || `${year}-12-31`,
        sum_insured: p.sum,
        deductible: p.deductible,
        premium: Math.round(p.sum * 0.018),
        insured_asset: p.asset,
        coverage_summary: `Fictional ${p.type.toLowerCase()} cover for demonstration purposes.`,
        payout_bank_name: 'Harbor Community Bank (fictional)',
        payout_account_number: p.account,
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
      const customer = users[policy ? Object.keys(users).find((k) => users[k].id === policy.holder_id) : spec.customer]
      const submittedAt = spec.status === 'DRAFT' ? null : ago(spec.ageDays)
      const steps = spec.status === 'DRAFT' ? [] : ['SUBMITTED', ...(spec.path || PATHS[spec.status] || [])]
      const stepTimes = steps.map((_, i) => new Date(submittedAt.getTime() + ((Date.now() - 2 * HOUR - submittedAt.getTime()) * i) / Math.max(steps.length, 1)))
      const lastAt = stepTimes[stepTimes.length - 1] || new Date()
      const status = spec.finalStatus || steps[steps.length - 1] || 'DRAFT'
      const verified = steps.includes('DOCUMENT_REVIEW') || steps.includes('DOCUMENTS_REQUIRED') || spec.verified

      const claim = await t.insert('claims', {
        claim_number: spec.status === 'DRAFT' ? null : spec.number,
        customer_id: customer.id,
        policy_id: policy.id,
        claim_type: policy.policy_type,
        status,
        hold_from_status: spec.holdFrom || null,
        priority: spec.priority || 'MEDIUM',
        insured_name: policy.insured_name,
        incident_at: spec.status === 'DRAFT' ? ago(1) : new Date(submittedAt.getTime() - (spec.incidentLeadDays ?? 2) * DAY),
        incident_location: spec.location,
        incident_category: spec.category,
        incident_description: spec.description,
        estimated_loss: spec.loss,
        affected_asset: spec.asset || policy.insured_asset,
        contact_name: customer.full_name,
        contact_phone: customer.phone || '+1 555 0100',
        contact_email: customer.email,
        declaration_accepted: spec.status !== 'DRAFT',
        declaration_accepted_at: submittedAt,
        draft_step: spec.draftStep || 6,
        submitted_at: submittedAt,
        assigned_owner_id: spec.owner ? users[spec.owner].id : steps.length > 1 ? users.olivia.id : null,
        assigned_adjuster_id: spec.adjuster ? users[spec.adjuster].id : null,
        assigned_reviewer_id: spec.reviewer ? users[spec.reviewer].id : null,
        due_date: STATUS_SLA_HOURS[status] ? new Date(lastAt.getTime() + STATUS_SLA_HOURS[status] * HOUR) : null,
        policy_verified: verified ? true : null,
        policy_verified_by: verified ? users.olivia.id : null,
        policy_verified_at: verified ? stepTimes[1] || submittedAt : null,
        policy_verification_notes: verified ? 'Policy active, coverage confirmed against policy record.' : null,
        intake_checklist: verified ? fullChecklist(INTAKE_CHECKLIST, users.olivia) : spec.partialChecklist ? { POLICY_ACTIVE: { checked: true, by: users.olivia.id, by_name: users.olivia.full_name, at: ago(0, 3).toISOString() } } : {},
        rejection_reason: spec.rejectionReason || null,
        closure_reason: status === 'CLOSED' ? 'Settled and paid' : null,
        closed_at: status === 'CLOSED' ? lastAt : null,
        escalation_level: spec.escalation || 0,
        escalated_at: spec.escalation ? ago(1) : null,
        escalation_reason: spec.escalation ? spec.escalationReason : null,
        created_by: customer.id,
        created_at: submittedAt ? new Date(submittedAt.getTime() - HOUR) : ago(0, 5),
      })

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
          actor_roles: [],
          action: 'CLAIM_STATUS_CHANGED',
          entity_type: 'claim',
          entity_id: claim.id,
          claim_id: claim.id,
          after_data: { status: to },
          metadata: { from: previous, to, seed: true },
          created_at: stepTimes[i],
        })
        previous = to
      }

      if (claim.assigned_owner_id) await assign(claim, 'OPERATIONS_OWNER', claim.assigned_owner_id, stepTimes[1] || submittedAt)
      if (claim.assigned_reviewer_id) await assign(claim, 'DOCUMENT_REVIEWER', claim.assigned_reviewer_id, stepTimes[2] || submittedAt)
      if (claim.assigned_adjuster_id) await assign(claim, 'ADJUSTER', claim.assigned_adjuster_id, stepTimes[4] || submittedAt)
      return { ...claim, stepTimes }
    }

    async function assign(claim, role, userId, at) {
      await t.insert('claim_assignments', {
        claim_id: claim.id,
        assignee_id: userId,
        assignment_role: role,
        assigned_by: role === 'ADJUSTER' ? users.maria.id : users.olivia.id,
        assigned_at: at,
      })
    }

    async function addDoc(claim, { category, name, status = 'ACCEPTED', reviewer = 'raj', rejection, daysAgo = 3, uploadedBy }) {
      const id = randomUUID()
      const storagePath = `claims/${claim.id}/${id}.pdf`
      const pdf = buildSamplePdf([
        'HarborPoint General Insurance — SAMPLE DOCUMENT',
        'Fictional demonstration data. Not a real record.',
        `Claim: ${claim.claim_number || 'draft'}`,
        `Category: ${category}`,
        `File: ${name}`,
      ])
      files.push({ path: storagePath, buffer: pdf })
      const reviewed = status === 'ACCEPTED' || status === 'REJECTED'
      return t.insert('documents', {
        id,
        claim_id: claim.id,
        document_group_id: randomUUID(),
        version_no: 1,
        category,
        file_name: name,
        storage_path: storagePath,
        mime_type: 'application/pdf',
        size_bytes: pdf.length,
        checksum_sha256: createHash('sha256').update(pdf).digest('hex'),
        status,
        uploaded_by: uploadedBy || claim.customer_id,
        uploaded_at: ago(daysAgo),
        reviewer_id: reviewer ? users[reviewer].id : null,
        review_assigned_at: reviewer ? ago(daysAgo) : null,
        reviewed_by: reviewed ? users[reviewer].id : null,
        reviewed_at: reviewed ? ago(Math.max(daysAgo - 1, 0), 2) : null,
        review_comment: status === 'ACCEPTED' ? 'Legible and complete.' : null,
        rejection_reason: status === 'REJECTED' ? rejection : null,
      })
    }

    const requiredDocs = {
      MOTOR: [['PROOF_OF_LOSS', 'proof-of-loss.pdf'], ['PHOTOS', 'damage-photos.pdf'], ['REPAIR_ESTIMATE', 'repair-estimate.pdf']],
      PROPERTY: [['PROOF_OF_LOSS', 'proof-of-loss.pdf'], ['PHOTOS', 'property-damage-photos.pdf']],
      HEALTH: [['MEDICAL_REPORT', 'discharge-summary.pdf'], ['INVOICE', 'hospital-invoice.pdf']],
      TRAVEL: [['PROOF_OF_LOSS', 'airline-report.pdf'], ['INVOICE', 'replacement-receipts.pdf']],
      LIABILITY: [['PROOF_OF_LOSS', 'third-party-claim-letter.pdf']],
    }
    const acceptRequired = async (claim, daysAgo = 8) => {
      for (const [category, name] of requiredDocs[claim.claim_type]) await addDoc(claim, { category, name, daysAgo })
    }

    async function addAssessment(claim, { adjuster, status, version = 1, est, rec, recommendation = 'PAY_PARTIAL', findings, reviewedBy, comment }) {
      return t.insert('assessments', {
        claim_id: claim.id,
        version_no: version,
        adjuster_id: users[adjuster].id,
        status,
        checklist: status === 'DRAFT' ? { SITE_INSPECTION: true, STATEMENTS_COLLECTED: true } : Object.fromEntries(INVESTIGATION_CHECKLIST.map((i) => [i.key, true])),
        findings,
        evidence: [{ description: 'Site inspection photographs and adjuster notes' }],
        estimated_loss: est,
        recommended_settlement: rec,
        recommendation,
        internal_notes: 'Seeded demo assessment.',
        submitted_at: status === 'DRAFT' ? null : ago(4),
        reviewed_by: reviewedBy ? users[reviewedBy].id : null,
        reviewed_at: reviewedBy ? ago(3) : null,
        review_comment: comment || null,
      })
    }

    async function addReserve(claim, assessment, { amount, status, decidedBy, comments }) {
      const reserve = await t.insert('reserves', {
        claim_id: claim.id,
        assessment_id: assessment.id,
        amount,
        reason: 'Reserve per adjuster assessment',
        status,
        requested_by: assessment.adjuster_id,
        requested_at: ago(4),
        decided_at: decidedBy ? ago(3, 20) : null,
      })
      if (decidedBy) {
        await t.insert('approvals', {
          claim_id: claim.id,
          approval_type: 'RESERVE',
          reserve_id: reserve.id,
          amount,
          decision: status === 'SUPERSEDED' ? 'RETURNED' : status,
          requested_by: assessment.adjuster_id,
          decided_by: users[decidedBy].id,
          comments: comments || 'Reserve consistent with assessment.',
          decided_at: ago(3, 20),
        })
      }
      return reserve
    }

    async function addCompliance(claim, { status, hold = false, flags = [], notes, decidedBy }) {
      return t.insert('compliance_reviews', {
        claim_id: claim.id,
        status,
        checklist: ['CLEARED', 'EXCEPTION_APPROVED'].includes(status) ? Object.fromEntries(COMPLIANCE_CHECKLIST.map((i) => [i.key, true])) : { SANCTIONS_SCREENING: status !== 'PENDING' },
        risk_flags: flags,
        evidence: [],
        decision_notes: notes || null,
        hold_active: hold,
        hold_placed_by: hold ? users.carlos.id : null,
        hold_placed_at: hold ? ago(1) : null,
        reviewer_id: status === 'PENDING' ? null : users.carlos.id,
        decided_by: decidedBy ? users[decidedBy].id : null,
        decided_at: decidedBy ? ago(2, 12) : null,
        created_by: users.maria.id,
        created_at: ago(2, 20),
      })
    }

    async function addSettlement(claim, assessment, { amount, status, decidedBy, policy }) {
      const settlement = await t.insert('settlements', {
        claim_id: claim.id,
        assessment_id: assessment.id,
        amount,
        status,
        beneficiary_name: policy.insured_name,
        beneficiary_bank: policy.payout_bank_name,
        beneficiary_account: policy.payout_account_number,
        notes: `Settlement per assessment v${assessment.version_no}`,
        requested_by: assessment.adjuster_id,
        requested_at: ago(2, 10),
        decided_at: decidedBy ? ago(2) : null,
      })
      if (decidedBy) {
        await t.insert('approvals', {
          claim_id: claim.id,
          approval_type: 'SETTLEMENT',
          settlement_id: settlement.id,
          amount,
          decision: status,
          requested_by: assessment.adjuster_id,
          decided_by: users[decidedBy].id,
          comments: 'Settlement approved within authority.',
          decided_at: ago(2),
        })
      }
      return settlement
    }

    async function addPayment(claim, settlement, { status, attempts = [], reconciled = false }) {
      const payment = await t.insert('payments', {
        claim_id: claim.id,
        settlement_id: settlement.id,
        amount: settlement.amount,
        status,
        beneficiary_name: settlement.beneficiary_name,
        beneficiary_bank: settlement.beneficiary_bank,
        beneficiary_account: settlement.beneficiary_account,
        provider: 'SIMULATED',
        is_simulated: true,
        transaction_reference: attempts.find((a) => a.status === 'SUCCEEDED')?.ref || null,
        attempt_count: attempts.length,
        last_failure_reason: attempts.filter((a) => a.status === 'FAILED').pop()?.reason || null,
        paid_at: ['PAID', 'RECONCILED'].includes(status) ? ago(1, 4) : null,
        reconciled_at: reconciled ? ago(1) : null,
        reconciled_by: reconciled ? users.priya.id : null,
        reconciliation_reference: reconciled ? 'RECON-SIM-0042' : null,
        created_by: users.maria.id,
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

    async function addTask(claim, { title, type = 'GENERAL', assignee, role, dueInHours, mandatory = false, status = 'OPEN', priority }) {
      return t.insert('tasks', {
        claim_id: claim?.id || null,
        title,
        task_type: type,
        status,
        priority: priority || claim?.priority || 'MEDIUM',
        is_mandatory: mandatory,
        assignee_id: assignee ? users[assignee].id : null,
        assigned_role: role || null,
        due_at: dueInHours == null ? null : new Date(Date.now() + dueInHours * HOUR),
        created_by: users.olivia.id,
        completed_at: status === 'DONE' ? ago(1) : null,
        completed_by: status === 'DONE' && assignee ? users[assignee].id : null,
      })
    }

    async function note(userKey, claim, type, title, message, daysAgo = 1, read = false) {
      await t.insert('notifications', {
        recipient_id: users[userKey].id,
        claim_id: claim?.id || null,
        type,
        title,
        message,
        link: claim ? (users[userKey].roles.includes('CUSTOMER') ? `/customer/claims/${claim.id}` : `/claims/${claim.id}`) : null,
        is_read: read,
        read_at: read ? ago(daysAgo - 0.5) : null,
        email_status: 'LOGGED_DEV',
        created_at: ago(daysAgo),
      })
    }

    // ------------------------------------------------------------------ claims
    const c = {}

    c.draft = await addClaim({
      status: 'DRAFT', policy: 'aliceMotor', draftStep: 3, category: 'WINDSCREEN', loss: 650,
      location: 'I-95 northbound near exit 7', description: 'Stone chip cracked the windscreen while driving on the highway.',
    })

    c.submitted = await addClaim({
      status: 'SUBMITTED', number: 'HPC-2026-000101', policy: 'benHealth', ageDays: 0.25, category: 'OUTPATIENT', loss: 2400, priority: 'LOW',
      location: 'Riverside Medical Clinic', description: 'Outpatient treatment for a fractured wrist after a fall at home, including X-rays and casting.',
    })
    await addTask(c.submitted, { title: 'Intake review for HPC-2026-000101', type: 'INTAKE_REVIEW', role: 'CLAIMS_OPERATIONS', dueInHours: 18, mandatory: true })

    c.verification = await addClaim({
      status: 'POLICY_VERIFICATION', number: 'HPC-2026-000102', policy: 'chenLiability', ageDays: 1.5, category: 'THIRD_PARTY_PROPERTY', loss: 18500,
      priority: 'HIGH', owner: 'olivia', partialChecklist: true,
      location: 'Client office, 88 Market Street', description: 'Installation error during a studio fit-out damaged the client’s flooring and custom cabinetry.',
    })
    await addTask(c.verification, { title: 'Intake review for HPC-2026-000102', type: 'INTAKE_REVIEW', assignee: 'olivia', dueInHours: -4, mandatory: true })

    c.docsRequired = await addClaim({
      status: 'DOCUMENTS_REQUIRED', number: 'HPC-2026-000103', policy: 'aliceHome', ageDays: 6, category: 'WATER_DAMAGE', loss: 12800, reviewer: 'raj',
      location: '14 Harbor View Lane, Portsmouth', description: 'Burst pipe in the upstairs bathroom flooded the kitchen ceiling and damaged cabinets and flooring.',
      reasons: { DOCUMENTS_REQUIRED: 'Photos rejected: images too dark to assess the damage' },
    })
    await addDoc(c.docsRequired, { category: 'PROOF_OF_LOSS', name: 'plumber-report.pdf', daysAgo: 5 })
    await addDoc(c.docsRequired, { category: 'PHOTOS', name: 'kitchen-ceiling-photos.pdf', status: 'REJECTED', rejection: 'Images too dark to assess the damage', daysAgo: 5 })
    await t.insert('information_requests', {
      claim_id: c.docsRequired.id, request_type: 'DOCUMENT', document_category: 'PHOTOS',
      message: 'Please upload a replacement photos: images too dark to assess the damage', requested_by: users.raj.id,
      due_at: new Date(Date.now() + 4 * DAY), created_at: ago(3),
    })
    await t.insert('information_requests', {
      claim_id: c.docsRequired.id, request_type: 'INFORMATION', message: 'When was the plumbing last serviced? Please share the approximate date.',
      requested_by: users.olivia.id, due_at: new Date(Date.now() + 4 * DAY), created_at: ago(3),
    })
    await addTask(c.docsRequired, { title: 'Follow up rejected Photos: kitchen-ceiling-photos.pdf', type: 'DOCUMENT_FOLLOW_UP', assignee: 'raj', dueInHours: 96 })

    c.docReview = await addClaim({
      status: 'DOCUMENT_REVIEW', number: 'HPC-2026-000104', policy: 'benHealth', ageDays: 3, category: 'HOSPITALISATION', loss: 9600, reviewer: 'raj',
      location: 'St. Anne’s Hospital', description: 'Two-night hospital stay for acute appendicitis with laparoscopic appendectomy.',
    })
    await addDoc(c.docReview, { category: 'MEDICAL_REPORT', name: 'discharge-summary.pdf', status: 'PENDING_REVIEW', daysAgo: 2 })
    await addDoc(c.docReview, { category: 'INVOICE', name: 'hospital-invoice.pdf', status: 'PENDING_REVIEW', daysAgo: 2 })

    c.adjAssign = await addClaim({
      status: 'ADJUSTER_ASSIGNMENT', number: 'HPC-2026-000105', policy: 'chenMotor', ageDays: 5, category: 'COLLISION', loss: 6900, reviewer: 'raj',
      location: 'Car park, Westfield Mall', description: 'Another vehicle reversed into the rear passenger door while parked; the other driver left contact details.',
    })
    await acceptRequired(c.adjAssign, 4)
    await addTask(c.adjAssign, { title: 'Assign an adjuster to HPC-2026-000105', type: 'ASSIGN_ADJUSTER', role: 'CLAIMS_MANAGER', dueInHours: -6, mandatory: true })

    c.investigation = await addClaim({
      status: 'INVESTIGATION', number: 'HPC-2026-000106', policy: 'aliceMotor', ageDays: 9, category: 'THEFT', loss: 3100, reviewer: 'raj', adjuster: 'adam',
      location: 'Residential street outside 14 Harbor View Lane', description: 'Vehicle broken into overnight; dashboard camera, sunglasses and a laptop bag were stolen.',
    })
    await addDoc(c.investigation, { category: 'PROOF_OF_LOSS', name: 'stolen-items-list.pdf', daysAgo: 8 })
    await addDoc(c.investigation, { category: 'PHOTOS', name: 'broken-window-photos.pdf', daysAgo: 8 })
    await addDoc(c.investigation, { category: 'REPAIR_ESTIMATE', name: 'glass-repair-quote.pdf', daysAgo: 8 })
    await addDoc(c.investigation, { category: 'POLICE_REPORT', name: 'police-report-PR-55812.pdf', daysAgo: 7 })
    await addAssessment(c.investigation, { adjuster: 'adam', status: 'DRAFT', est: 2850, rec: 2350, findings: 'Police report confirms forced entry. Awaiting receipts for the laptop bag.' })
    await addTask(c.investigation, { title: 'Investigate claim HPC-2026-000106', type: 'INVESTIGATION', assignee: 'adam', dueInHours: 120, mandatory: true })

    c.reserveSmall = await addClaim({
      status: 'RESERVE_APPROVAL', number: 'HPC-2026-000107', policy: 'benHealth', ageDays: 14, category: 'SURGERY', loss: 21000, priority: 'HIGH', reviewer: 'raj', adjuster: 'amara',
      location: 'Lakeside Orthopaedic Centre', description: 'Knee arthroscopy following a sports injury, with physiotherapy sessions afterwards.',
    })
    await acceptRequired(c.reserveSmall, 12)
    {
      const a = await addAssessment(c.reserveSmall, { adjuster: 'amara', status: 'SUBMITTED', est: 19800, rec: 18500, findings: 'Treatment medically necessary per surgeon’s notes; two physiotherapy sessions exceed plan limits and are excluded.' })
      await addReserve(c.reserveSmall, a, { amount: 18500, status: 'PENDING_APPROVAL' })
    }

    c.reserveLarge = await addClaim({
      status: 'RESERVE_APPROVAL', number: 'HPC-2026-000108', policy: 'chenLiability', ageDays: 20, category: 'THIRD_PARTY_INJURY', loss: 145000, priority: 'URGENT', reviewer: 'raj', adjuster: 'adam',
      escalation: 1, escalationReason: 'High-value bodily injury claim; legal counsel engaged by third party.',
      location: 'Wei Design Studio showroom', description: 'A visitor tripped over an unsecured display platform in the showroom and fractured an ankle.',
    })
    await acceptRequired(c.reserveLarge, 18)
    {
      const a = await addAssessment(c.reserveLarge, { adjuster: 'adam', status: 'SUBMITTED', est: 132000, rec: 120000, findings: 'Liability accepted. Medical costs and lost earnings substantiated; general damages estimated from comparable cases.' })
      await addReserve(c.reserveLarge, a, { amount: 120000, status: 'PENDING_APPROVAL' })
    }

    c.complianceHold = await addClaim({
      status: 'COMPLIANCE_REVIEW', number: 'HPC-2026-000109', policy: 'aliceHome', ageDays: 25, category: 'STORM', loss: 38500, priority: 'HIGH', reviewer: 'raj', adjuster: 'amara',
      location: '14 Harbor View Lane, Portsmouth', description: 'Storm winds removed roof tiles; rainwater damaged the loft insulation and bedroom ceilings.',
    })
    await acceptRequired(c.complianceHold, 22)
    {
      const a = await addAssessment(c.complianceHold, { adjuster: 'amara', status: 'APPROVED', est: 36200, rec: 34900, findings: 'Roofing contractor estimate verified; storm event confirmed by regional weather data.', reviewedBy: 'maria' })
      await addReserve(c.complianceHold, a, { amount: 36000, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.complianceHold, {
        status: 'HOLD', hold: true,
        flags: [{ code: 'SANCTIONS_MATCH', severity: 'HIGH', note: 'Roofing contractor name is a partial match on a watch list; verification requested.', resolved: false }],
        notes: 'Payee contractor partially matches a sanctions watch list entry. Hold until verified.',
      })
    }
    await addTask(c.complianceHold, { title: 'Verify contractor identity against sanctions list', type: 'COMPLIANCE', assignee: 'carlos', dueInHours: 24, mandatory: true })

    c.complianceClean = await addClaim({
      status: 'COMPLIANCE_REVIEW', number: 'HPC-2026-000110', policy: 'benTravel', ageDays: 16, category: 'LOST_BAGGAGE', loss: 1850, priority: 'LOW', reviewer: 'raj', adjuster: 'amara',
      location: 'Lisbon Airport, Portugal', description: 'Checked suitcase was not delivered on arrival and was declared lost by the airline after 21 days.',
    })
    await acceptRequired(c.complianceClean, 14)
    {
      const a = await addAssessment(c.complianceClean, { adjuster: 'amara', status: 'APPROVED', est: 1850, rec: 1600, findings: 'Airline property irregularity report verified. Depreciation applied to clothing items.', reviewedBy: 'maria' })
      await addReserve(c.complianceClean, a, { amount: 1700, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.complianceClean, { status: 'PENDING' })
    }

    c.settlement = await addClaim({
      status: 'SETTLEMENT_APPROVAL', number: 'HPC-2026-000111', policy: 'chenMotor', ageDays: 22, category: 'VANDALISM', loss: 8400, reviewer: 'raj', adjuster: 'adam',
      location: 'Office parking garage, Level 2', description: 'Vehicle paintwork scratched along both sides and a wing mirror broken while parked overnight.',
    })
    await acceptRequired(c.settlement, 20)
    {
      const a = await addAssessment(c.settlement, { adjuster: 'adam', status: 'APPROVED', est: 8100, rec: 7800, findings: 'Bodyshop estimate reasonable; deductible applied.', reviewedBy: 'maria' })
      await addReserve(c.settlement, a, { amount: 8000, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.settlement, { status: 'CLEARED', decidedBy: 'carlos', notes: 'All screening checks passed.' })
      await addSettlement(c.settlement, a, { amount: 7800, status: 'PENDING_APPROVAL', policy: policies.chenMotor })
    }

    c.paymentPending = await addClaim({
      status: 'PAYMENT_PENDING', number: 'HPC-2026-000112', policy: 'aliceMotor', ageDays: 28, category: 'COLLISION', loss: 5200, reviewer: 'raj', adjuster: 'adam',
      location: 'Junction of Pier Road and Elm Street', description: 'Low-speed collision at a junction; front bumper and headlight damaged. Third party admitted fault.',
    })
    await acceptRequired(c.paymentPending, 26)
    {
      const a = await addAssessment(c.paymentPending, { adjuster: 'adam', status: 'APPROVED', est: 4900, rec: 4400, findings: 'Repair estimate verified with approved garage; deductible applied.', reviewedBy: 'maria' })
      await addReserve(c.paymentPending, a, { amount: 4600, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.paymentPending, { status: 'CLEARED', decidedBy: 'carlos' })
      const s = await addSettlement(c.paymentPending, a, { amount: 4400, status: 'APPROVED', decidedBy: 'maria', policy: policies.aliceMotor })
      await addPayment(c.paymentPending, s, { status: 'PENDING' })
    }

    c.paymentFailed = await addClaim({
      status: 'PAYMENT_FAILED', number: 'HPC-2026-000113', policy: 'chenMotor', ageDays: 30, category: 'WINDSCREEN', loss: 1450, priority: 'MEDIUM', reviewer: 'raj', adjuster: 'amara',
      location: 'Route 1 southbound', description: 'Windscreen shattered by debris from a truck; replaced at an approved glass repairer.',
    })
    await acceptRequired(c.paymentFailed, 28)
    {
      const a = await addAssessment(c.paymentFailed, { adjuster: 'amara', status: 'APPROVED', est: 1450, rec: 1200, recommendation: 'PAY_PARTIAL', findings: 'Glass invoice verified; deductible applied.', reviewedBy: 'maria' })
      await addReserve(c.paymentFailed, a, { amount: 1300, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.paymentFailed, { status: 'CLEARED', decidedBy: 'carlos' })
      const s = await addSettlement(c.paymentFailed, a, { amount: 1200, status: 'APPROVED', decidedBy: 'maria', policy: policies.chenMotor })
      await addPayment(c.paymentFailed, s, { status: 'FAILED', attempts: [{ status: 'FAILED', code: 'ACCOUNT_CLOSED', reason: 'Simulated: beneficiary account is closed' }] })
    }
    await addTask(c.paymentFailed, { title: 'Obtain updated bank details from claimant', type: 'PAYMENT', assignee: 'priya', dueInHours: 20, mandatory: true, priority: 'HIGH' })

    c.paid = await addClaim({
      status: 'PAID', number: 'HPC-2026-000114', policy: 'benTravel', ageDays: 35, category: 'TRIP_CANCELLATION', loss: 3200, reviewer: 'raj', adjuster: 'amara',
      location: 'Home — trip to Kyoto, Japan', description: 'Trip cancelled two days before departure due to hospitalisation of an immediate family member.',
    })
    await acceptRequired(c.paid, 33)
    {
      const a = await addAssessment(c.paid, { adjuster: 'amara', status: 'APPROVED', est: 3200, rec: 3100, recommendation: 'PAY_FULL', findings: 'Non-refundable bookings verified; medical certificate supports cancellation.', reviewedBy: 'maria' })
      await addReserve(c.paid, a, { amount: 3100, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.paid, { status: 'CLEARED', decidedBy: 'carlos' })
      const s = await addSettlement(c.paid, a, { amount: 3100, status: 'APPROVED', decidedBy: 'maria', policy: policies.benTravel })
      await addPayment(c.paid, s, { status: 'PAID', attempts: [{ status: 'SUCCEEDED', ref: 'SIM-TXN-7F3A91C2D4E8' }] })
    }

    c.closed = await addClaim({
      status: 'CLOSED', number: 'HPC-2026-000115', policy: 'aliceHome', ageDays: 60, category: 'ACCIDENTAL_DAMAGE', loss: 2100, priority: 'LOW', reviewer: 'raj', adjuster: 'adam',
      location: '14 Harbor View Lane, Portsmouth', description: 'Television knocked off its stand during furniture moving; screen cracked beyond repair.',
    })
    await acceptRequired(c.closed, 58)
    {
      const a = await addAssessment(c.closed, { adjuster: 'adam', status: 'APPROVED', est: 1900, rec: 1100, findings: 'Like-for-like replacement value less deductible.', reviewedBy: 'maria' })
      await addReserve(c.closed, a, { amount: 1100, status: 'APPROVED', decidedBy: 'maria' })
      await addCompliance(c.closed, { status: 'CLEARED', decidedBy: 'carlos' })
      const s = await addSettlement(c.closed, a, { amount: 1100, status: 'APPROVED', decidedBy: 'maria', policy: policies.aliceHome })
      await addPayment(c.closed, s, { status: 'RECONCILED', attempts: [{ status: 'SUCCEEDED', ref: 'SIM-TXN-2B9D44A0F1C7' }], reconciled: true })
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
    await note('maria', c.reserveSmall, 'APPROVAL_REQUIRED', 'Reserve approval required: HPC-2026-000107', 'Reserve of 18500.00 requested by Amara Nwosu.', 1)
    await note('maria', c.reserveLarge, 'APPROVAL_REQUIRED', 'Reserve approval required: HPC-2026-000108', 'Reserve of 120000.00 requested by Adam Brooks. Exceeds your limit — refer to a senior manager.', 1)
    await note('sam', c.reserveLarge, 'APPROVAL_REQUIRED', 'Reserve approval required: HPC-2026-000108', 'Reserve of 120000.00 requested by Adam Brooks.', 1)
    await note('maria', c.complianceHold, 'COMPLIANCE_HOLD', 'Compliance hold: HPC-2026-000109', 'A compliance hold blocks settlement and payment until cleared.', 1)
    await note('carlos', c.complianceClean, 'APPROVAL_REQUIRED', 'Compliance review required: HPC-2026-000110', 'Claim HPC-2026-000110 is ready for compliance review.', 2)
    await note('priya', c.paymentPending, 'APPROVAL_DECISION', 'Payment ready: HPC-2026-000112', 'Approved settlement of 4400.00 is awaiting payment processing.', 2)
    await note('priya', c.paymentFailed, 'PAYMENT_FAILED', 'Payment failed: HPC-2026-000113', 'Simulated: beneficiary account is closed', 1)

    await addTask(null, { title: 'Prepare weekly claims aging summary', assignee: 'olivia', dueInHours: 48, priority: 'LOW' })
    await addTask(c.reserveLarge, { title: 'Review legal counsel correspondence', type: 'GENERAL', assignee: 'sam', dueInHours: -20, priority: 'URGENT' })
    await addTask(c.closed, { title: 'Send settlement confirmation letter', type: 'GENERAL', assignee: 'olivia', status: 'DONE', dueInHours: -400 })

    await t.insert('audit_logs', {
      actor_id: users.dana.id,
      actor_roles: ['DATA_ADMIN'],
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
