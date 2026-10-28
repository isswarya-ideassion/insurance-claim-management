import { ok, created } from '../../utils/http.js'
import { isStaff, loadAccessibleClaim, requireStaffView } from '../../services/access.service.js'
import { claimClocks } from '../../services/sla.service.js'
import { draftSchema, staffClaimUpdateSchema } from './claims.validators.js'
import * as service from './claims.service.js'

const STAFF_FIELDS = ['priority', 'dueDate', 'complexity']

export async function list(req, res) {
  const { items, meta } = await service.listClaims(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function stats(req, res) {
  ok(res, await service.claimStats(req.ctx))
}

export async function createDraft(req, res) {
  created(res, await service.createDraft(req.ctx, req.body))
}

export async function detail(req, res) {
  ok(res, await service.getClaimDetail(req.ctx, req.params.id))
}

export async function update(req, res) {
  // Staff-only metadata fields vs. claimant draft fields are validated separately.
  const staffFields = isStaff(req.user) && STAFF_FIELDS.some((f) => f in req.body)
  const body = staffFields ? staffClaimUpdateSchema.parse(req.body) : draftSchema.parse(req.body)
  ok(res, await service.updateClaim(req.ctx, req.params.id, body, staffFields ? 'staff' : 'draft'))
}

export async function remove(req, res) {
  ok(res, await service.deleteDraft(req.ctx, req.params.id))
}

export async function submit(req, res) {
  const submissionKey = req.body.submissionKey || req.get('idempotency-key') || undefined
  const result = await service.submitClaim(req.ctx, req.params.id, { ...req.body, submissionKey })
  ok(res, result.claim, { replayed: result.replayed }, result.replayed ? 200 : 201)
}

export async function transitions(req, res) {
  ok(res, await service.getTransitions(req.ctx, req.params.id))
}

export async function changeStatus(req, res) {
  ok(res, await service.changeStatus(req.ctx, req.params.id, req.body))
}

export async function coverageCheck(req, res) {
  ok(res, await service.verifyCoverage(req.ctx, req.params.id, req.body))
}

export async function coverageResults(req, res) {
  ok(res, await service.listCoverageResults(req.ctx, req.params.id))
}

export async function slaClocks(req, res) {
  const claim = await loadAccessibleClaim(req.ctx.db, req.ctx.actor, req.params.id)
  requireStaffView(req.ctx.actor, claim)
  ok(res, await claimClocks(req.ctx.db, claim.id))
}

export async function intakeChecklist(req, res) {
  ok(res, await service.updateIntakeChecklist(req.ctx, req.params.id, req.body))
}

export async function escalate(req, res) {
  ok(res, await service.escalateClaim(req.ctx, req.params.id, req.body))
}

export async function documentException(req, res) {
  ok(res, await service.recordDocumentException(req.ctx, req.params.id, req.body))
}

export async function notes(req, res) {
  ok(res, await service.listNotes(req.ctx, req.params.id))
}

export async function addNote(req, res) {
  created(res, await service.addNote(req.ctx, req.params.id, req.body))
}

export async function timeline(req, res) {
  ok(res, await service.getTimeline(req.ctx, req.params.id))
}
