import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './automation.controller.js'
import {
  agentParams,
  applyAgentSchema,
  applyExtractionSchema,
  approveReminderSchema,
  discardAgentSchema,
  idParams,
  listRemindersQuery,
  reminderDraftSchema,
} from './automation.validators.js'

export function automationRoutes() {
  const router = Router()
  const byId = validate({ params: idParams })

  router.get('/automation/status', controller.status)

  // Claim agents (PRD section 3): coverage, triage, reserve, denial letter, payee and subrogation
  router.get('/claims/:id/agents/:agent', validate({ params: agentParams }), controller.listAgentRuns)
  router.post('/claims/:id/agents/:agent', validate({ params: agentParams }), controller.runAgent)
  router.post('/agent-runs/:id/apply', validate({ params: idParams, body: applyAgentSchema }), controller.applyAgentRun)
  router.post('/agent-runs/:id/discard', validate({ params: idParams, body: discardAgentSchema }), controller.discardAgentRun)

  // B + D. Missing-document detection and reminders (rule-based)
  router.get('/claims/:id/automation/document-checklist', byId, controller.documentChecklist)
  router.post('/claims/:id/automation/reminder-drafts', validate({ params: idParams, body: reminderDraftSchema }), controller.createReminderDraft)
  router.get('/claims/:id/automation/reminders', byId, controller.claimReminders)
  router.get('/automation/reminders', validate({ query: listRemindersQuery }), controller.listReminders)
  router.post('/automation/reminders/sweep', controller.runReminderSweep)
  router.post('/automation/reminders/:id/approve', validate({ params: idParams, body: approveReminderSchema }), controller.approveReminder)
  router.post('/automation/reminders/:id/discard', byId, controller.discardReminder)

  // A. Document extraction (AI; results need confirmation before they are saved)
  router.post('/documents/:id/extractions', byId, controller.extract)
  router.get('/claims/:id/automation/extractions', byId, controller.listExtractions)
  router.post('/automation/extractions/:id/apply', validate({ params: idParams, body: applyExtractionSchema }), controller.applyExtraction)
  router.post('/automation/extractions/:id/discard', byId, controller.discardExtraction)

  // C. Claim summary (recorded facts + AI suggestions)
  router.get('/claims/:id/automation/summary', byId, controller.getSummary)
  router.post('/claims/:id/automation/summary', byId, controller.generateSummary)

  return router
}
