import { ok, created } from '../../utils/http.js'
import * as reminders from './reminders.service.js'
import * as ai from './ai-automation.service.js'

export async function status(req, res) {
  ok(res, ai.getAiStatus(req.ctx))
}

export async function documentChecklist(req, res) {
  ok(res, await reminders.getDocumentChecklist(req.ctx, req.params.id))
}

export async function createReminderDraft(req, res) {
  created(res, await reminders.createReminderDraft(req.ctx, req.params.id, req.body))
}

export async function claimReminders(req, res) {
  ok(res, await reminders.listClaimReminders(req.ctx, req.params.id))
}

export async function listReminders(req, res) {
  const { items, meta } = await reminders.listReminders(req.ctx, req.validatedQuery)
  ok(res, items, meta)
}

export async function approveReminder(req, res) {
  ok(res, await reminders.approveReminder(req.ctx, req.params.id, req.body))
}

export async function discardReminder(req, res) {
  ok(res, await reminders.discardReminder(req.ctx, req.params.id))
}

export async function runReminderSweep(req, res) {
  ok(res, await reminders.triggerReminderSweep(req.ctx))
}

export async function extract(req, res) {
  created(res, await ai.runExtraction(req.ctx, req.params.id))
}

export async function listExtractions(req, res) {
  ok(res, await ai.listExtractions(req.ctx, req.params.id))
}

export async function applyExtraction(req, res) {
  ok(res, await ai.applyExtraction(req.ctx, req.params.id, req.body))
}

export async function discardExtraction(req, res) {
  ok(res, await ai.discardExtraction(req.ctx, req.params.id))
}

export async function getSummary(req, res) {
  ok(res, await ai.getSummary(req.ctx, req.params.id))
}

export async function generateSummary(req, res) {
  created(res, await ai.generateSummary(req.ctx, req.params.id))
}
