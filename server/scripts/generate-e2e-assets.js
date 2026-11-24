#!/usr/bin/env node
/**
 * Realistic end-to-end test assets for HarborPoint Claims (Beacon AI).
 *
 *   node server/scripts/generate-e2e-assets.js          generate + verify, no database
 *   node server/scripts/generate-e2e-assets.js --seed   also seed the two test policyholders
 *                                                       (needs DATABASE_URL in server/.env)
 *
 * Writes to <repo>/demo-assets/ (git- and deploy-ignored):
 *   flow-1-clean/                       a claim that should go straight through
 *   flow-2-fraud-and-wrong-proof/       wrong proof, mismatched bill, forged duplicate bill
 *   E2E-TEST-GUIDE.md                   exact form values, steps and the verified Beacon results
 *
 * Every document is typeset in the 5x7 typeface Beacon's OCR is trained on
 * (services/intelligence/vision/ocr.js), at print sizes, dark ink on white, so
 * the local OCR reads every amount, date and keyword. Each file is then run
 * through the real Beacon pipeline (OCR, relevance, image forensics, and the
 * Auto-Pilot document decision) and the script fails if any result differs
 * from what the guide promises.
 *
 * All businesses, people, GSTINs and numbers are fictional.
 *
 * Dates are relative to the day the script runs (loss 5 and 6 days ago). Run
 * it on the day you test; re-running with --seed refreshes the seeded
 * duplicate so it stays byte-identical to the regenerated forged bill.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { renderText } from '../src/services/intelligence/vision/ocr.js'
import { encodeGrayPng } from '../src/services/intelligence/vision/imageCodec.js'
import { readFileText } from '../src/services/intelligence/documentIntelligence.service.js'
import { assessRelevance, RELEVANCE } from '../src/services/intelligence/documentRelevance.js'
import { scanImage, fraudChecksOf } from '../src/services/intelligence/imageForensics.service.js'
import { createBeaconProvider } from '../src/services/intelligence/beacon.provider.js'
import { evaluatePolicyEligibility } from '../src/services/eligibility.service.js'
import { buildTextPdf } from '../src/utils/pdf.js'
import { extractAmount, parseIndianDate } from '../src/services/intelligence/indianFields.js'
import { coverageUnambiguous, decideDocument, payeeRisk, stpBlockers } from '../src/modules/automation/autopilot.service.js'
import { policyClauses } from '../src/modules/automation/agents.service.js'
import { AI_AGENTS, PRIVACY_NOTICE_VERSION } from '../../shared/constants.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const OUT = path.join(ROOT, 'demo-assets')
const FLOW1_DIR = path.join(OUT, 'flow-1-clean')
const FLOW2_DIR = path.join(OUT, 'flow-2-fraud-and-wrong-proof')
const SEED = process.argv.includes('--seed')

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const DAY = 86_400_000
const today = new Date()
today.setUTCHours(10, 30, 0, 0)
const daysFrom = (d, n) => new Date(d.getTime() + n * DAY)
const ddmmyyyy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`
const iso = (d) => d.toISOString().slice(0, 10)
const exifDate = (d) => d.toISOString().slice(0, 19).replace(/-/g, ':').replace('T', ' ')
const inr = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ---------------------------------------------------------------------------
// Scenario data (shared by the documents, the seed and the guide)
// ---------------------------------------------------------------------------
const DOMAIN = 'demo.harborpoint.test'

const FLOW1 = {
  user: { email: `e2e.meera@${DOMAIN}`, fullName: 'Meera Krishnan', phone: '+91 98401 22871' },
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
  user: { email: `e2e.rohan@${DOMAIN}`, fullName: 'Rohan Mehta', phone: '+91 98450 66713' },
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
  olderFileName: 'previous-claim-receipt.png',
}

// ---------------------------------------------------------------------------
// Page renderer: a 1200 x 1600 scanned page, dark ink on white
// ---------------------------------------------------------------------------
const W = 1200
const H = 1600
const INK = 22
const PAPER = 250
const SHADE = 232 // light table-header band; well above the binarisation threshold

function page() {
  const gray = new Uint8ClampedArray(W * H).fill(PAPER)
  const rect = (x, y, w, h, v = INK) => {
    for (let j = Math.max(0, y); j < Math.min(H, y + h); j += 1) gray.fill(v, j * W + Math.max(0, x), j * W + Math.min(W, x + w))
  }
  const width = (s, scale) => s.length * 6 * scale
  const text = (s, x, y, scale = 4) => {
    const r = renderText([s], { scale, padding: 0 })
    if (x + r.width > W - 50) throw new Error(`Line does not fit on the page: "${s}"`)
    for (let j = 0; j < r.height; j += 1) {
      for (let i = 0; i < r.width; i += 1) if (r.binary[j * r.width + i]) gray[(y + j) * W + x + i] = INK
    }
    return y + 9 * scale
  }
  const right = (s, xRight, y, scale = 4) => text(s, xRight - width(s, scale) + scale, y, scale)
  const centre = (s, y, scale = 4) => text(s, Math.round((W - width(s, scale)) / 2), y, scale)
  const border = () => {
    rect(36, 36, W - 72, 5)
    rect(36, H - 41, W - 72, 5)
    rect(36, 36, 5, H - 72)
    rect(W - 41, 36, 5, H - 72)
    rect(52, 52, W - 104, 2)
    rect(52, H - 54, W - 104, 2)
    rect(52, 52, 2, H - 104)
    rect(W - 54, 52, 2, H - 104)
  }
  return { gray, rect, text, right, centre, border }
}

/** A tax invoice: letterhead, meta block, itemised table, totals, footer. */
function invoicePage({ name, address, contact, gstin, title = 'TAX INVOICE', meta, items, subtotal, taxes = [], grandTotal, footer }) {
  const p = page()
  p.border()
  let y = 84
  y = p.centre(name, y, Math.min(7, Math.floor((W - 160) / (name.length * 6)))) + 6
  for (const line of address) y = p.centre(line, y, 3) + 2
  y = p.centre(contact, y, 3) + 2
  y = p.centre(`GSTIN ${gstin}`, y, 3) + 14
  p.rect(80, y, W - 160, 4)
  y += 22
  y = p.centre(title, y, 5) + 18
  for (const [label, value] of meta) {
    p.text(`${label}:`, 90, y, 4)
    y = p.text(value, 420, y, 4) + 8
  }
  y += 12
  // Table
  p.rect(80, y, W - 160, 3)
  p.rect(80, y + 3, W - 160, 52, SHADE)
  p.text('DESCRIPTION', 100, y + 15, 4)
  p.right('AMOUNT', 1100, y + 15, 4)
  y += 58
  p.rect(80, y, W - 160, 3)
  y += 18
  for (const [desc, amount] of items) {
    p.text(desc, 100, y, 4)
    y = p.right(inr(amount), 1100, y, 4) + 10
  }
  p.rect(80, y, W - 160, 2)
  y += 18
  p.text('SUB TOTAL', 100, y, 4)
  y = p.right(inr(subtotal), 1100, y, 4) + 10
  for (const [label, amount] of taxes) {
    p.text(label, 100, y, 4)
    y = p.right(inr(amount), 1100, y, 4) + 10
  }
  p.rect(80, y, W - 160, 4)
  y += 20
  y = p.text(`GRAND TOTAL: RS. ${inr(grandTotal)}`, 100, y, 5) + 8
  p.rect(80, y, W - 160, 4)
  y += 30
  for (const line of footer) y = p.text(line, 100, y, 3) + 6
  p.text('AUTHORISED SIGNATORY', 760, 1440, 3)
  p.rect(760, 1425, 340, 2)
  p.centre('COMPUTER GENERATED DOCUMENT - TEST DATA ONLY', 1500, 3)
  return p.gray
}

function png(gray, text) {
  return encodeGrayPng(W, H, gray, { text })
}

// ---------------------------------------------------------------------------
// Flow 1 documents
// ---------------------------------------------------------------------------
function flow1Invoice() {
  const c = FLOW1.claim
  const billDate = daysFrom(c.lossDate, 1)
  const items = [
    ['DAYCARE SURGERY PACKAGE', 9800],
    ['SURGEON AND ANAESTHETIST FEES', 4200],
    ['OPERATION THEATRE CHARGES', 2050],
    ['X-RAY KNEE AND BLOOD TESTS', 1520],
  ]
  const subtotal = items.reduce((s, [, a]) => s + a, 0) // 17,570
  const taxes = [['CGST 2.5 PCT ON CONSUMABLES', 440], ['SGST 2.5 PCT ON CONSUMABLES', 440]]
  const total = subtotal + 880
  if (total !== c.estimatedLoss) throw new Error(`Flow 1 invoice total ${total} != ${c.estimatedLoss}`)
  const gray = invoicePage({
    name: 'LOTUS SPECIALITY HOSPITAL',
    address: ['14 GREAMS LANE, THOUSAND LIGHTS', 'CHENNAI, TAMIL NADU 600006'],
    contact: 'TEL 044-4211 7700',
    gstin: '33AAFCL4821K1Z7',
    meta: [
      ['INVOICE NO', 'LSH/DC/2026/04817'],
      ['BILL DATE', ddmmyyyy(billDate)],
      ['PATIENT NAME', FLOW1.user.fullName.toUpperCase()],
      ['POLICY NO', FLOW1.policy.number],
      ['ADMISSION', ddmmyyyy(c.lossDate)],
      ['DISCHARGE', ddmmyyyy(c.lossDate)],
      ['TREATMENT', 'DAYCARE KNEE SURGERY'],
    ],
    items,
    subtotal,
    taxes,
    grandTotal: total,
    footer: ['PAYMENT MODE: CASHLESS PENDING - INSURANCE', 'THANK YOU FOR CHOOSING LOTUS SPECIALITY HOSPITAL'],
  })
  // A flatbed scan: scanner software and a scan time the day after the bill. No editor anywhere.
  return png(gray, { Software: 'Canon IJ Scan Utility Lite 3.2.1', Source: 'Canon CanoScan LiDE 300', 'Creation Time': exifDate(daysFrom(billDate, 1)) })
}

function flow1Report() {
  const c = FLOW1.claim
  return buildTextPdf(
    [
      'LOTUS SPECIALITY HOSPITAL',
      '14 Greams Lane, Thousand Lights, Chennai, Tamil Nadu 600006   |   Tel 044-4211 7700',
      '',
      'DISCHARGE SUMMARY - DAYCARE SURGERY',
      '',
      `Patient name: ${FLOW1.user.fullName}`,
      `Insured name: ${FLOW1.user.fullName}`,
      `Policy number: ${FLOW1.policy.number}`,
      'Hospital ID: LSH-UHID-2026-118204',
      `Date of injury (loss date): ${ddmmyyyy(c.lossDate)}`,
      `Date of admission: ${ddmmyyyy(c.lossDate)} 08:40`,
      `Date of discharge: ${ddmmyyyy(c.lossDate)} 18:15`,
      `Place of treatment: ${c.location}, ${c.city}`,
      '',
      'Presenting complaint: Pain and locking of the right knee after a fall on wet stairs at home earlier the same morning.',
      'Diagnosis: Acute tear of the medial meniscus, right knee (confirmed on examination and imaging).',
      'Procedure: Daycare arthroscopic partial meniscectomy under spinal anaesthesia. Uneventful.',
      'Investigations: X-ray right knee (no fracture); complete blood count and coagulation profile within normal limits.',
      'Condition at discharge: Stable, walking with support. Advised physiotherapy for two weeks.',
      'Follow-up: Orthopaedic outpatient review in 10 days.',
      '',
      'BILLING SUMMARY',
      'Daycare surgery package: Rs. 9,800.00',
      'Surgeon and anaesthetist fees: Rs. 4,200.00',
      'Operation theatre charges: Rs. 2,050.00',
      'X-ray and blood tests: Rs. 1,520.00',
      'GST on consumables: Rs. 880.00',
      `Total bill amount: ₹${inr(c.estimatedLoss)}`,
      `Final bill no LSH/DC/2026/04817 dated ${ddmmyyyy(daysFrom(c.lossDate, 1))}`,
      '',
      'Treating surgeon: Dr. K. Raghavan, MS (Ortho), Reg. No. TNMC 88214',
      '',
      'This is a computer generated document (test data only).',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// Flow 2 documents
// ---------------------------------------------------------------------------

/**
 * A grocery till receipt: real, legible text with nothing an insurer would
 * use. Beacon counts any claim term, any date and any formatted amount
 * (Rs. 640, 640.00, 1,640) as evidence of relevance, so a till receipt reads as
 * unrelated only without them: prices are whole numbers and there is no date.
 */
function supermarketReceipt() {
  const p = page()
  p.border()
  let y = 110
  y = p.centre('FRESHMART GROCERS', y, 7) + 8
  y = p.centre('12 HUDSON MARKET LANE', y, 4) + 4
  y = p.centre('PH 98860 41207', y, 4) + 4
  y = p.centre('FSSAI LIC 10019043000512', y, 3) + 28
  p.rect(90, y, W - 180, 3)
  y += 24
  p.text('TILL 03', 100, y, 4)
  y = p.right('CASHIER SUNITA', 1100, y, 4) + 22
  p.rect(90, y, W - 180, 3)
  p.rect(90, y + 3, W - 180, 50, SHADE)
  p.text('ITEM', 100, y + 14, 4)
  p.text('QTY', 640, y + 14, 4)
  p.right('PRICE', 1100, y + 14, 4)
  y += 56
  p.rect(90, y, W - 180, 3)
  y += 20
  const items = [
    ['ORGANIC MILK 1 LTR', 2, 68],
    ['WHOLE WHEAT BREAD', 1, 55],
    ['COFFEE BEANS 250 G', 1, 272],
    ['BANANA CHIPS', 2, 45],
    ['FARM EGGS 6 PCS', 1, 87],
  ]
  let sum = 0
  for (const [name, qty, price] of items) {
    p.text(name, 100, y, 4)
    p.text(`${qty} X ${price}`, 640, y, 4)
    y = p.right(String(qty * price), 1100, y, 4) + 12
    sum += qty * price
  }
  if (sum !== 640) throw new Error(`Receipt sum ${sum} != 640`)
  p.rect(90, y, W - 180, 2)
  y += 20
  p.text('SUBTOTAL', 100, y, 5)
  y = p.right(String(sum), 1100, y, 5) + 12
  p.text('PAID BY UPI', 100, y, 4)
  y = p.right(String(sum), 1100, y, 4) + 12
  p.text('ITEMS 7', 100, y, 4)
  y += 60
  y = p.centre('THANK YOU - VISIT AGAIN', y, 4) + 8
  p.centre('FRESH VEGETABLES DAILY', y, 3)
  p.centre('TEST DATA ONLY - FICTIONAL STORE', 1500, 3)
  // Phone camera photo taken yesterday.
  return png(p.gray, { Software: 'Android 14 - SM-A546E camera', Make: 'samsung', Model: 'SM-A546E', 'Creation Time': exifDate(daysFrom(today, -1)) })
}

/** A clinic bill with valid layout but the wrong person, a pre-loss date and a far larger total. */
function mismatchedBill() {
  const lossDate = FLOW2.claim.lossDate
  const billDate = daysFrom(lossDate, -60)
  const items = [
    ['ROOM CHARGES - 3 DAYS', 18000],
    ['PHYSIOTHERAPY SESSIONS', 9500],
    ['CONSULTATION AND PROCEDURE', 16500],
    ['PHARMACY AND CONSUMABLES', 8000],
  ]
  const subtotal = items.reduce((s, [, a]) => s + a, 0)
  if (subtotal !== 52000) throw new Error('Mismatched bill total')
  const gray = invoicePage({
    name: 'SUNRISE MULTISPECIALITY CLINIC',
    address: ['88 KARVE ROAD, KOTHRUD', 'PUNE, MAHARASHTRA 411038'],
    contact: 'TEL 020-2543 9911',
    gstin: '27AAGFS7734M1Z2',
    meta: [
      ['INVOICE NO', 'SMC/IP/2026/7731'],
      ['BILL DATE', ddmmyyyy(billDate)],
      ['PATIENT NAME', 'ANIL DESHPANDE'],
      ['ADMISSION', ddmmyyyy(daysFrom(billDate, -3))],
      ['DISCHARGE', ddmmyyyy(billDate)],
      ['TREATMENT', 'LOWER BACK PAIN - CONSERVATIVE'],
    ],
    items,
    subtotal,
    grandTotal: subtotal,
    footer: ['PAYMENT MODE: CARD', 'GET WELL SOON'],
  })
  return png(gray, { Software: 'Android 14 - SM-A546E camera', Make: 'samsung', Model: 'SM-A546E', 'Creation Time': exifDate(daysFrom(today, -1)) })
}

/** The forged bill: claimant's own name and policy, inflated total, pre-loss date, Photoshop metadata. */
function forgedInvoice() {
  const lossDate = FLOW2.claim.lossDate
  const billDate = daysFrom(lossDate, -18)
  const items = [
    ['EMERGENCY ROOM AND OBSERVATION', 14500],
    ['ORTHOPAEDIC SURGEON FEES', 18000],
    ['WRIST CT SCAN AND X-RAY', 16500],
    ['PHARMACY AND CONSUMABLES', 13500],
  ]
  const subtotal = items.reduce((s, [, a]) => s + a, 0)
  if (subtotal !== 62500) throw new Error('Forged bill total')
  const gray = invoicePage({
    name: 'LAKESIDE CARE HOSPITAL',
    address: ['OUTER RING ROAD, BELLANDUR', 'BENGALURU, KARNATAKA 560103'],
    contact: 'TEL 080-4980 3300',
    gstin: '29AAECL5519P1Z4',
    meta: [
      ['INVOICE NO', 'LCH/ER/2026/02294'],
      ['BILL DATE', ddmmyyyy(billDate)],
      ['PATIENT NAME', FLOW2.user.fullName.toUpperCase()],
      ['POLICY NO', FLOW2.policy.number],
      ['TREATMENT', 'EMERGENCY - WRIST INJURY'],
    ],
    items,
    subtotal,
    grandTotal: subtotal,
    footer: ['PAYMENT MODE: CASH', 'THANK YOU FOR CHOOSING LAKESIDE CARE HOSPITAL'],
  })
  return png(gray, {
    Software: 'Adobe Photoshop 25.4 (Windows)',
    'Creation Time': exifDate(daysFrom(lossDate, -20)),
    Comment: 'Fictional forged bill for HarborPoint fraud-detection testing',
  })
}

// ---------------------------------------------------------------------------
// Verification against the real Beacon pipeline
// ---------------------------------------------------------------------------
const failures = []
const expect = (ok, message) => {
  if (!ok) failures.push(message)
  return ok
}

function claimFacts(flow, extra = {}) {
  return {
    id: randomUUID(),
    claim_number: null,
    claim_type: flow.policy.type,
    estimated_loss: flow.claim.estimatedLoss,
    loss_date: flow.claim.lossDate.toISOString(),
    loss_location: flow.claim.location,
    loss_city: flow.claim.city,
    insured_name: flow.user.fullName,
    ...extra,
  }
}
const policyFacts = (flow) => ({ external_policy_no: flow.policy.number, insured_name: flow.user.fullName })

function verifyImage(label, buffer, { flow, docType, duplicates = [] }) {
  const claim = claimFacts(flow)
  const read = readFileText(buffer, 'image/png')
  const relevance = assessRelevance({ read, docType, claim, policy: policyFacts(flow) })
  const alert = scanImage({ buffer, document: { id: randomUUID(), file_name: label, doc_type: docType, mime_type: 'image/png' }, claim, policy: policyFacts(flow), duplicates })
  const fraudChecks = alert ? fraudChecksOf(alert) : []
  const decision = decideDocument({ fraudAlerts: alert ? [alert] : [], relevance: alert?.relevance === 'IRRELEVANT' ? 'IRRELEVANT' : relevance.status, detail: relevance.detail })
  return { label, docType, read, relevance, alert, fraudChecks, decision }
}

function verifyPdf(label, buffer, { flow, docType }) {
  const read = readFileText(buffer, 'application/pdf')
  const relevance = assessRelevance({ read, docType, claim: claimFacts(flow), policy: policyFacts(flow) })
  const decision = decideDocument({ fraudAlerts: [], relevance: relevance.status, detail: relevance.detail })
  return { label, docType, read, relevance, alert: null, fraudChecks: [], decision }
}

/** Beacon's coverage and triage rules for the claim as the client will submit it. */
async function verifyClaimRules(flow, { priorStatuses, taxonomy }) {
  const beacon = createBeaconProvider({ aiError: (status, code, message) => Object.assign(new Error(message), { status, code }) })
  const year = today.getUTCFullYear()
  const policy = {
    policy_type: flow.policy.type,
    status: 'ACTIVE',
    insured_id: 'holder',
    effective_date: iso(daysFrom(today, -300)),
    expiry_date: iso(daysFrom(today, 65)),
    sum_insured: flow.policy.sumInsured,
    deductible: flow.policy.deductible,
    coverages: flow.policy.coverages,
    exclusions: flow.policy.exclusions,
    limits: { sum_insured: flow.policy.sumInsured },
    deductibles: { per_claim: flow.policy.deductible },
    coverage_summary: `${flow.policy.asset} (${year}).`,
  }
  const loss = {
    claim_type: flow.policy.type,
    loss_type: flow.claim.lossType,
    loss_date: flow.claim.lossDate.toISOString(),
    days_from_loss_to_report: Math.round((today - flow.claim.lossDate) / DAY),
    estimated_loss: flow.claim.estimatedLoss,
    affected_asset: flow.policy.asset,
  }
  const clauses = policyClauses(policy)
  const hard = evaluatePolicyEligibility(policy, { customerId: 'holder', lossDate: loss.loss_date, claimType: loss.claim_type, lossType: loss.loss_type, estimatedLoss: loss.estimated_loss })
  const cov = (await beacon.generateJson({ agent: AI_AGENTS.COVERAGE_CHECKER, input: { loss, policy: { ...policy, clauses }, hard_checks: { passed: hard.eligible, failed_reasons: hard.reasons } } })).data
  const coverage = {
    result: hard.eligible || cov.result !== 'COVERED' ? cov.result : 'NEEDS_REVIEW',
    hardChecks: { passed: hard.eligible, reasons: hard.reasons },
    coveringClauses: cov.covering_clause_ids.map((id) => ({ id })),
    exclusionClauses: cov.exclusion_clause_ids.map((id) => ({ id })),
  }
  const tri = (await beacon.generateJson({
    agent: AI_AGENTS.TRIAGE_ROUTER,
    input: {
      loss,
      policy: { sum_insured: policy.sum_insured, effective_date: policy.effective_date },
      prior_claims_on_policy_24_months: priorStatuses,
      possible_duplicate: false,
      documents: [],
      severity_thresholds: { LOW: 0, MEDIUM: 10000, HIGH: 100000, CATASTROPHIC: 500000 },
      fraud_reason_taxonomy: taxonomy,
      candidate_adjusters: [{ alias: 'A1', open_claims: 3, high_priority_open: 0, claims_handled_by_type: {} }],
      image_forensics: [],
    },
  })).data
  const triage = { fraudReasons: tri.fraud_reasons, fraudBand: tri.fraud_score >= 60 ? 'HIGH' : tri.fraud_score >= 30 ? 'MEDIUM' : 'LOW', aboveReviewThreshold: tri.fraud_score >= 60, imageFraudAlerts: [], fraudScore: tri.fraud_score }
  const blockers = stpBlockers({ claim: { estimated_loss: flow.claim.estimatedLoss, possible_duplicate_of: null }, maxLoss: 25_000, triage, risk: { openFraudFlags: 0, ring: null, anomalyBand: null, complianceHold: false } })
  return { coverage, coverageOk: coverageUnambiguous(coverage), clauses, triage, blockers }
}

// Codes and weights from the fraud_reason_codes reference data; replaced by the database's when --seed connects.
let TAXONOMY = [
  ['LATE_NOTIFICATION', 20], ['DUPLICATE_SUSPECTED', 40], ['HIGH_VALUE', 15], ['RAPID_CLAIM_AFTER_INCEPTION', 25], ['NO_TRADING_HISTORY', 10],
  ['DOCUMENT_TAMPERING', 45], ['DUPLICATE_DOCUMENT_IMAGE', 40], ['IMAGE_PREDATES_LOSS', 30],
].map(([code, weight]) => ({ code, weight, description: code }))

// ---------------------------------------------------------------------------
// Seed (optional): two clean policyholders, their policies, history and the duplicate
// ---------------------------------------------------------------------------
async function seed(buffers) {
  dotenv.config({ path: path.join(ROOT, 'server/.env'), quiet: true })
  const { loadConfig } = await import('../src/config/env.js')
  const { createDependencies } = await import('../src/services/container.js')
  const deps = await createDependencies(loadConfig(process.env), { seed: false })
  const { db, crypto, storage, authProvider, config } = deps
  const log = []
  try {
    TAXONOMY = await db.query('select code, weight, description from public.fraud_reason_codes where active')
    const [priya] = await db.query('select id from public.users where email = $1', [`payments.priya@${DOMAIN}`])
    const [olivia] = await db.query('select id from public.users where email = $1', [`ops.olivia@${DOMAIN}`])
    if (!priya || !olivia) throw new Error('Demo staff users not found: seed the demo data first (SEED_DEMO_DATA=true or npm run db:seed-demo)')

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
      let policy = await t.findOne('policies', { external_policy_no: flow.policy.number })
      if (policy) return policy
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
      policy = await t.insert('policies', {
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
      const buffer = buffers.forged
      const sha = createHash('sha256').update(buffer).digest('hex')
      const have = await t.query(
        `select 1 from public.documents d join public.document_files f on f.storage_key = d.storage_key where d.claim_id = $1 and f.sha256 = $2 limit 1`,
        [older.id, sha],
      )
      if (!have.length) {
        const id = randomUUID()
        const storageKey = `claims/${older.id}/${id}.png`
        const received = daysFrom(today, -13)
        await storage.put(storageKey, buffer, 'image/png', t)
        const doc = await t.insert('documents', {
          id,
          claim_id: older.id,
          version: 1,
          doc_type: 'INVOICE',
          file_name: FLOW2.olderFileName,
          storage_key: storageKey,
          mime_type: 'image/png',
          size_bytes: buffer.length,
          sha256: sha,
          source: 'WEB',
          status: 'ACCEPTED',
          uploaded_by: rohan.id,
          received_at: received,
          reviewer_id: null,
          reviewed_by: null,
        })
        await t.insert('document_versions', { document_id: doc.id, version_no: 1, storage_key: storageKey, file_name: doc.file_name, mime_type: 'image/png', size_bytes: buffer.length, sha256: sha, status: 'ACCEPTED', uploaded_by: rohan.id, uploaded_at: received })
        log.push(`filed ${FLOW2.olderFileName} (sha256 ${sha.slice(0, 12)}...) on ${older.claim_number}`)
      }
    })

    // Neither test policyholder may sit in a fraud ring (they share no bank account, payee or premises with anyone).
    const rings = await db.query(
      `select r.band, r.status from public.fraud_rings r join public.fraud_ring_members m on m.ring_id = r.id where m.entity_id = any($1::uuid[]) and r.status <> 'DISMISSED'`,
      [[meera.id, rohan.id]],
    )
    expect(rings.length === 0, `a test policyholder is in a fraud ring: ${JSON.stringify(rings)}`)
    const olderClaim = await db.query(`select c.claim_number from public.claims c join public.policies p on p.id = c.policy_id where p.external_policy_no = $1 and c.status = 'CLOSED' order by c.opened_at limit 1`, [FLOW2.policy.number])
    return { log, olderClaimNumber: olderClaim[0]?.claim_number || null, staffPassword: '(the DEMO_PASSWORD from server/.env)' }
  } finally {
    await db.close()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const lineCount = (t) => t.split('\n').filter(Boolean).length
const excerpt = (t, n = 14) => t.split('\n').filter(Boolean).slice(0, n).join('\n')

async function main() {
  mkdirSync(FLOW1_DIR, { recursive: true })
  mkdirSync(FLOW2_DIR, { recursive: true })

  const files = {
    invoice: flow1Invoice(),
    report: flow1Report(),
    receipt: supermarketReceipt(),
    mismatched: mismatchedBill(),
    forged: forgedInvoice(),
  }
  const out = {
    invoice: path.join(FLOW1_DIR, 'clean-hospital-invoice.png'),
    report: path.join(FLOW1_DIR, 'clean-medical-report.pdf'),
    receipt: path.join(FLOW2_DIR, 'wrong-proof-supermarket-receipt.png'),
    mismatched: path.join(FLOW2_DIR, 'wrong-wording-mismatched-bill.png'),
    forged: path.join(FLOW2_DIR, 'forged-tampered-invoice.png'),
  }
  for (const [k, p] of Object.entries(out)) writeFileSync(p, files[k])

  const seeded = SEED ? await seed(files) : null

  // --- Verify every file with the real pipeline
  const v = {
    invoice: verifyImage('clean-hospital-invoice.png', files.invoice, { flow: FLOW1, docType: 'INVOICE' }),
    report: verifyPdf('clean-medical-report.pdf', files.report, { flow: FLOW1, docType: 'MEDICAL_REPORT' }),
    receipt: verifyImage('wrong-proof-supermarket-receipt.png', files.receipt, { flow: FLOW2, docType: 'INVOICE' }),
    mismatched: verifyImage('wrong-wording-mismatched-bill.png', files.mismatched, { flow: FLOW2, docType: 'INVOICE' }),
    forged: verifyImage('forged-tampered-invoice.png', files.forged, {
      flow: FLOW2,
      docType: 'INVOICE',
      duplicates: [{ claimNumber: seeded?.olderClaimNumber || 'the seeded older claim', documentId: randomUUID(), fileName: FLOW2.olderFileName }],
    }),
  }
  const ocr = (r) => r.alert?.ocr ?? null
  const checks = (r) => r.fraudChecks.map((c) => c.check).sort()

  // Flow 1: clean, readable, relevant, accepted
  expect(v.invoice.read.hasTextLayer && v.invoice.read.ocrConfidence >= 0.9, `invoice OCR confidence ${v.invoice.read.ocrConfidence}`)
  expect(v.invoice.read.text.includes(`GRAND TOTAL: RS. ${inr(FLOW1.claim.estimatedLoss)}`), 'invoice OCR did not read the grand total exactly')
  expect(v.invoice.read.text.includes(ddmmyyyy(daysFrom(FLOW1.claim.lossDate, 1))), 'invoice OCR did not read the bill date')
  expect(v.invoice.read.text.includes(FLOW1.policy.number), 'invoice OCR did not read the policy number')
  expect(v.invoice.relevance.status === RELEVANCE.RELEVANT, `invoice relevance ${v.invoice.relevance.status}`)
  expect(v.invoice.alert === null, `invoice raised forensics checks: ${JSON.stringify(v.invoice.alert?.checks)}`)
  expect(v.invoice.decision.decision === 'ACCEPT', `invoice Auto-Pilot decision ${v.invoice.decision.decision}`)
  expect(v.report.read.hasTextLayer && v.report.relevance.status === RELEVANCE.RELEVANT, `report relevance ${v.report.relevance.status}`)
  expect(v.report.decision.decision === 'ACCEPT', `report Auto-Pilot decision ${v.report.decision.decision}`)

  // Flow 2 A: readable, unrelated, no fraud flag, rejected
  expect(v.receipt.read.hasTextLayer && v.receipt.read.ocrConfidence >= 0.9, `receipt OCR confidence ${v.receipt.read.ocrConfidence}`)
  expect(v.receipt.read.text.includes('FRESHMART GROCERS') && v.receipt.read.text.includes('SUBTOTAL 640'), 'receipt OCR text')
  expect(v.receipt.relevance.status === RELEVANCE.IRRELEVANT, `receipt relevance ${v.receipt.relevance.status} (${v.receipt.relevance.signals?.join(', ')})`)
  expect(v.receipt.fraudChecks.length === 0, `receipt raised fraud checks ${checks(v.receipt)}`)
  expect(v.receipt.decision.decision === 'REJECT', `receipt Auto-Pilot decision ${v.receipt.decision.decision}`)

  // Flow 2 B: relevant layout, but the total and the date contradict the claim
  expect(v.mismatched.relevance.status === RELEVANCE.RELEVANT, `mismatched bill relevance ${v.mismatched.relevance.status}`)
  expect(ocr(v.mismatched)?.amount === 52000, `mismatched bill OCR amount ${ocr(v.mismatched)?.amount}`)
  expect(JSON.stringify(checks(v.mismatched)) === JSON.stringify(['AMOUNT_MISMATCH', 'BILL_DATE_BEFORE_LOSS']), `mismatched bill checks ${checks(v.mismatched)}`)
  expect(v.mismatched.decision.decision === 'ESCALATE', `mismatched bill decision ${v.mismatched.decision.decision}`)

  // Flow 2 C: every check fires
  const allFive = ['AMOUNT_MISMATCH', 'BILL_DATE_BEFORE_LOSS', 'CAPTURED_BEFORE_LOSS', 'DUPLICATE_IMAGE', 'EDITING_SOFTWARE']
  expect(ocr(v.forged)?.amount === 62500, `forged bill OCR amount ${ocr(v.forged)?.amount}`)
  expect(JSON.stringify(checks(v.forged)) === JSON.stringify(allFive), `forged bill checks ${checks(v.forged)}`)
  expect(v.forged.alert?.riskLevel === 'HIGH', `forged bill risk ${v.forged.alert?.riskLevel}`)
  expect(v.forged.decision.decision === 'ESCALATE' && v.forged.decision.highRisk, 'forged bill should escalate as high risk')

  // Claim rules: Flow 1 must be straight-through; Flow 2's intake is clean too (its problem is the documents).
  const rules1 = await verifyClaimRules(FLOW1, { priorStatuses: ['CLOSED'], taxonomy: TAXONOMY })
  expect(rules1.coverageOk, `flow 1 coverage not unambiguous: ${JSON.stringify(rules1.coverage)}`)
  expect(rules1.blockers.length === 0, `flow 1 STP blockers: ${rules1.blockers.map((b) => b.code).join(', ')} / reasons ${JSON.stringify(rules1.triage.fraudReasons)}`)
  const rules2 = await verifyClaimRules(FLOW2, { priorStatuses: ['CLOSED'], taxonomy: TAXONOMY })
  expect(rules2.coverageOk, `flow 2 coverage not unambiguous: ${JSON.stringify(rules2.coverage)}`)
  expect(payeeRisk({ signals: [], anomalies: [] }).level === 'NONE', 'payee risk baseline')

  writeFileSync(path.join(OUT, 'E2E-TEST-GUIDE.md'), guide({ v, rules1, rules2, seeded }))

  // --- Report
  const row = (r) => `${r.label.padEnd(38)} OCR ${(r.read.ocrConfidence ?? (r.read.hasTextLayer ? 'text layer' : '-')).toString().padEnd(10)} ${r.relevance.status.padEnd(10)} checks [${checks(r).join(', ')}] -> ${r.decision.decision}`
  console.log(`\nAssets written to ${path.relative(process.cwd(), OUT) || OUT}`)
  for (const r of Object.values(v)) console.log(`  ${row(r)}`)
  console.log(`  Flow 1 coverage ${rules1.coverage.result} (clauses ${rules1.coverage.coveringClauses.map((c) => c.id).join(',')}), fraud score ${rules1.triage.fraudScore}, STP blockers: ${rules1.blockers.length || 'none'}`)
  if (seeded) for (const l of seeded.log) console.log(`  seed: ${l}`)
  if (failures.length) {
    console.error(`\n${failures.length} verification failure(s):\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
  console.log(`\nAll ${Object.keys(v).length} documents and both claim scenarios verified against Beacon. Guide: demo-assets/E2E-TEST-GUIDE.md${SEED ? '' : '\nRun again with --seed to create the test policyholders in the database.'}`)
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------
function guide({ v, rules1, rules2, seeded }) {
  const f1 = FLOW1.claim
  const f2 = FLOW2.claim
  const local = (d) => `${iso(d)} 10:30`
  // What Beacon's own parsers take from the text it read (the same ones the forensics check uses).
  const totalRead = (r) => extractAmount(r.read.text)?.value ?? null
  const dateRead = (r) => {
    const lines = r.read.text.split('\n')
    const line = lines.find((l) => /bill\s*date|invoice\s*date|dated/i.test(l) && parseIndianDate(l)) || lines.find((l) => parseIndianDate(l))
    return line ? parseIndianDate(line) : null
  }
  const res = (r) => {
    const amount = totalRead(r)
    return `| \`${r.label}\` | ${r.docType.replace('_', ' ')} | ${r.read.ocrConfidence != null ? `OCR ${r.read.ocrConfidence}` : 'PDF text layer'}, ${lineCount(r.read.text)} lines | ${amount != null ? `₹${inr(amount)}` : 'none'} | ${dateRead(r) || 'none'} | **${r.relevance.status}** | ${r.fraudChecks.length ? r.fraudChecks.map((c) => `${c.check} (${c.severity})`).join('<br>') : '0'} | **${r.decision.decision}** |`
  }
  return `# HarborPoint E2E test guide (Beacon AI)

Generated ${iso(today)} by \`node server/scripts/generate-e2e-assets.js${SEED ? ' --seed' : ''}\`. Dates below are relative to that day:
**run the script again on the day you test** (with \`--seed\`, it also refreshes the seeded duplicate).

All businesses, people, GSTINs and numbers are fictional. Staff and test-client passwords are \`DEMO_PASSWORD\` from \`server/.env\`.

${seeded ? `Seeded in your database (${seeded.log.length ? 'created this run' : 'already present, unchanged this run'}): clients \`${FLOW1.user.email}\` and \`${FLOW2.user.email}\`, policies \`${FLOW1.policy.number}\` and \`${FLOW2.policy.number}\`, one closed prior claim each${seeded.olderClaimNumber ? `, and \`${FLOW2.olderFileName}\` on ${seeded.olderClaimNumber}` : ''}.${seeded.log.length ? `\n${seeded.log.map((l) => `- ${l}`).join('\n')}` : ''}\n` : '> Not seeded yet. Run `node server/scripts/generate-e2e-assets.js --seed` to create the two test policyholders.\n'}
## What Beacon reads in each file (verified by the script)

Every row below is the output of the real pipeline (\`readFileText\` OCR, \`assessRelevance\`, \`scanImage\`, Auto-Pilot \`decideDocument\`) against the claim as you will submit it.

| File | Upload as | Read | Total read | Bill date read | Relevance | Fraud checks | Auto-Pilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
${Object.values(v).map(res).join('\n')}

---

## Flow 1 — clean claim, straight through (start → closure)

**Policyholder:** ${FLOW1.user.fullName} — sign in as \`${FLOW1.user.email}\`
**Policy:** \`${FLOW1.policy.number}\` (Health, active, sum insured ₹${inr(FLOW1.policy.sumInsured)}, deductible ₹${inr(FLOW1.policy.deductible)}).
Payee already verified (${FLOW1.policy.bankName} ••••${FLOW1.policy.account.slice(-4)}), one settled claim eight months ago, no shared bank account, payee or premises with anyone, so not in any fraud ring.

### New claim form (exact values)
| Field | Value |
| --- | --- |
| Policy | \`${FLOW1.policy.number}\` |
| Loss date & time | \`${local(f1.lossDate)}\` (5 days ago) |
| Loss type | \`Surgery\` |
| Loss location | \`${f1.location}\` |
| City / country | \`${f1.city}\` / \`India\` |
| Estimated loss | \`${f1.estimatedLoss}\` |
| Affected property / asset | \`${FLOW1.policy.asset}\` (pre-filled from the policy — keep it) |
| Description | ${f1.description} |
| Contact | pre-filled; keep |

### Documents
| File | Document type |
| --- | --- |
| \`flow-1-clean/clean-hospital-invoice.png\` | **Invoice** |
| \`flow-1-clean/clean-medical-report.pdf\` | **Medical report** |

### Steps and expected results
Beacon AI Auto-Pilot must be **ON** (Operations dashboard control bar), \`AI_PROVIDER=beacon\`. Click **Run Auto-Pilot Sweep** after each human step (or wait for the scheduled sweep).

1. **Client** (${FLOW1.user.email}): create the claim with the values above, upload both files, accept the declaration, submit.
2. **Sweep → intake.** Coverage is verified straight through (verified by the script: ${rules1.coverage.result} on ${rules1.coverage.coveringClauses.map((c) => c.id).join(', ')} *${rules1.clauses.find((c) => c.id === rules1.coverage.coveringClauses[0]?.id)?.text}*, no exclusion; triage fraud score ${rules1.triage.fraudScore}, band ${rules1.triage.fraudBand}, ${rules1.triage.fraudReasons.length} reason codes). The claim shows **Auto-handled by Beacon AI**; the Claims Ops owner is notified.
3. **Claims Ops Manager** (owner, e.g. \`ops.olivia\` or \`ops.omar\`): **Start coverage verification**, tick the five intake checklist items. Payee is already verified.
   *The auto-pilot never ticks the checklist or moves a claim out of intake: those stay human by design.*
4. **Sweep → documents.** Both documents are **auto-accepted** (invoice OCR reads \`GRAND TOTAL: RS. ${inr(f1.estimatedLoss)}\`, 0 fraud flags, RELEVANT).
5. **Claims Ops Manager:** **Send to document review**.
6. **Sweep → documents complete → routing → pre-work.** "Documents complete — triage" is applied, the **least-loaded adjuster** is assigned and the claim moves to **Investigation**; the reserve recommendation and subrogation assessment are pre-computed on the claim.
7. **Adjuster** (the assigned one, \`adjuster.adam\` or \`adjuster.amara\`): accept the AI reserve (₹${inr(f1.estimatedLoss)} or the suggested point), complete the investigation checklist, submit the evaluation (recommend settle ₹${inr(f1.estimatedLoss)}), then **Submit evaluation** (within reserve authority it goes to Compliance review; above it, to a Claims Manager for reserve approval first).
8. **Compliance** (\`compliance.carlos\`): complete the checklist, **Clear** → Settlement approval.
9. **Settlement approval:** ₹${inr(f1.estimatedLoss)} is above the adjuster's ₹15,000 settlement authority, so a **Claims Manager** (\`manager.maria\`, ₹50,000) approves, then **Release for payment**.
10. **Payment Operator** (\`payments.priya\` or \`payments.paul\` — not the approver): issue the payment (simulated, reference \`SIM-…\`) → Paid.
11. **Adjuster** requests closure → **Claims Manager** closes the claim.

---

## Flow 2 — wrong proof and real image-fraud detection

**Policyholder:** ${FLOW2.user.fullName} — sign in as \`${FLOW2.user.email}\`
**Policy:** \`${FLOW2.policy.number}\` (Health, active). ${seeded?.olderClaimNumber ? `His earlier claim **${seeded.olderClaimNumber}** (closed, withdrawn)` : 'His earlier (seeded) claim'} already holds \`${FLOW2.olderFileName}\`, **byte-identical** to \`forged-tampered-invoice.png\`.

### New claim form (exact values)
| Field | Value |
| --- | --- |
| Policy | \`${FLOW2.policy.number}\` |
| Loss date & time | \`${local(f2.lossDate)}\` (6 days ago) |
| Loss type | \`Emergency\` |
| Loss location | \`${f2.location}\` |
| City / country | \`${f2.city}\` / \`India\` |
| Estimated loss | \`${f2.estimatedLoss}\` |
| Affected property / asset | \`${FLOW2.policy.asset}\` (pre-filled) |
| Description | ${f2.description} |

Coverage for this claim is also unambiguous (${rules2.coverage.result} on ${rules2.coverage.coveringClauses.map((c) => c.id).join(', ')}): the problems are in the documents.

### Documents and expected results
Upload each as **Invoice** (in this order, running a sweep after each, or all three then one sweep):

| File | What Beacon does |
| --- | --- |
| \`wrong-proof-supermarket-receipt.png\` | OCR reads the FreshMart till receipt (milk, bread, coffee beans, chips, eggs — \`SUBTOTAL 640\`). No claim evidence → **IRRELEVANT**: the amber **Unnecessary / Non-Claim Document** notice, **0 fraud flags**. The auto-pilot rejects it with *"Auto-rejected by Beacon AI: unnecessary or non-claim document"* and the client is asked for the right document (or a Document Reviewer clicks **Reject Document**). |
| \`wrong-wording-mismatched-bill.png\` | Readable clinic bill for a different patient (Anil Deshpande, Pune): OCR total ₹52,000.00 vs claimed ₹${inr(f2.estimatedLoss)} → **AMOUNT_MISMATCH (HIGH)**; bill dated ${iso(daysFrom(f2.lossDate, -60))}, 60 days before the loss → **BILL_DATE_BEFORE_LOSS (HIGH)**. Stays pending, escalated to the top of the review queue as a fraud alert. |
| \`forged-tampered-invoice.png\` | Red **Beacon AI Image Forensics Alert**, risk HIGH, all five checks: **DUPLICATE_IMAGE** (same SHA-256 as \`${FLOW2.olderFileName}\` on ${seeded?.olderClaimNumber || 'the seeded claim'}), **EDITING_SOFTWARE** ("Adobe Photoshop 25.4 (Windows)"), **CAPTURED_BEFORE_LOSS** (capture ${iso(daysFrom(f2.lossDate, -20))}), **AMOUNT_MISMATCH** (₹62,500.00 vs ₹${inr(f2.estimatedLoss)}), **BILL_DATE_BEFORE_LOSS** (${iso(daysFrom(f2.lossDate, -18))}). Escalated first in the review queue; the Fraud shield opens an **AI-flagged priority** review in the Compliance queue (no hold). A reviewer can **Accept Alert & Flag Fraud** to record the fraud flags. |

Nothing in Flow 2 is approved, paid, held or denied automatically.

### Note on the supermarket receipt
Beacon counts **any** claim term (\`TOTAL\`, \`RS\`, \`BILL\`, \`RECEIPT\`, \`INVOICE\`…), **any** date and **any** formatted amount (\`Rs. 640\`, \`640.00\`) as evidence that a file relates to a claim. A till receipt printed with \`Rs. 640\` or a date is therefore judged *relevant* and is not auto-rejected, so this receipt prints whole-rupee prices, \`SUBTOTAL 640\` and no date. Worth knowing before demoing with a real receipt.

---

## Re-running
- \`node server/scripts/generate-e2e-assets.js\` — regenerate and re-verify (no database).
- \`node server/scripts/generate-e2e-assets.js --seed\` — also create/refresh the test policyholders (idempotent).
- To repeat a flow, start a **new claim**; uploading the same clean invoice to a second claim would itself be a duplicate.
`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
