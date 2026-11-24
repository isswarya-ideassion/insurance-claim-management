import { ok, created } from '../../utils/http.js'
import * as reminders from './reminders.service.js'
import * as ai from './ai-automation.service.js'
import * as agents from './agents.service.js'
import * as imageAlerts from './image-alerts.service.js'
import * as autoExtraction from './auto-extraction.service.js'
import * as autopilot from './autopilot.service.js'

export async function status(req, res) {
  ok(res, ai.getAiStatus(req.ctx))
}

export async function autopilotSummary(req, res) {
  ok(res, await autopilot.getAutopilotSummary(req.ctx, req.validatedQuery))
}

export async function autopilotState(req, res) {
  ok(res, await autopilot.getAutopilotState(req.ctx))
}

export async function setAutopilotState(req, res) {
  ok(res, await autopilot.setAutopilotEnabled(req.ctx, req.body))
}

export async function runAutopilot(req, res) {
  ok(res, await autopilot.triggerAutopilotSweep(req.ctx, req.body))
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

export async function ensureExtraction(req, res) {
  ok(res, await autoExtraction.ensureDocumentExtraction(req.ctx, req.params.id))
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

export async function listAgentRuns(req, res) {
  ok(res, await agents.listAgentRuns(req.ctx, req.params.id, req.params.agent))
}

export async function runAgent(req, res) {
  created(res, await agents.runAgent(req.ctx, req.params.id, req.params.agent))
}

export async function applyAgentRun(req, res) {
  ok(res, await agents.applyAgentRun(req.ctx, req.params.id, req.body))
}

export async function acceptRunImageAlert(req, res) {
  ok(res, await imageAlerts.acceptRunImageAlert(req.ctx, req.params.id))
}

export async function documentImageForensics(req, res) {
  ok(res, await imageAlerts.getDocumentImageForensics(req.ctx, req.params.id))
}

export async function acceptDocumentImageAlert(req, res) {
  ok(res, await imageAlerts.acceptDocumentImageAlert(req.ctx, req.params.id))
}

export async function discardAgentRun(req, res) {
  ok(res, await agents.discardAgentRun(req.ctx, req.params.id, req.body))
}
