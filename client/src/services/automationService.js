import { api } from './apiClient.js'

export const customersService = {
  list: (params) => api.get('/customers', params),
  get: (id) => api.get(`/customers/${id}`).then((r) => r.data),
  exportCsv: (params) => api.blob('/customers/export', params),
  downloadDocument: (customerId, documentId, disposition = 'attachment') =>
    api.blob(`/customers/${customerId}/documents/${documentId}/download`, { disposition }),
}

const ensureInflight = new Map()

export const automationService = {
  status: () => api.get('/automation/status').then((r) => r.data),
  // Beacon AI Auto-Pilot (straight-through processing; exceptions stay with people)
  autopilotSummary: (params) => api.get('/automation/autopilot/summary', params).then((r) => r.data),
  setAutopilotEnabled: (enabled) => api.put('/automation/autopilot/state', { enabled }).then((r) => r.data),
  runAutopilot: (body = {}) => api.post('/automation/autopilot/run', body).then((r) => r.data),
  documentChecklist: (claimId) => api.get(`/claims/${claimId}/automation/document-checklist`).then((r) => r.data),
  createReminderDraft: (claimId, body = {}) => api.post(`/claims/${claimId}/automation/reminder-drafts`, body).then((r) => r.data),
  claimReminders: (claimId) => api.get(`/claims/${claimId}/automation/reminders`).then((r) => r.data),
  reminders: (params) => api.get('/automation/reminders', params),
  approveReminder: (id, message) => api.post(`/automation/reminders/${id}/approve`, message ? { message } : {}).then((r) => r.data),
  discardReminder: (id) => api.post(`/automation/reminders/${id}/discard`).then((r) => r.data),
  runReminderSweep: () => api.post('/automation/reminders/sweep').then((r) => r.data),
  extract: (documentId) => api.post(`/documents/${documentId}/extractions`).then((r) => r.data),
  // Scans the document's current version if it has no run yet, then returns the latest run.
  // Auto-triggered from effects, so concurrent calls for one document share a single POST.
  ensureExtraction: (documentId) => {
    if (!ensureInflight.has(documentId)) {
      ensureInflight.set(documentId, api.post(`/documents/${documentId}/extractions/ensure`).then((r) => r.data).finally(() => ensureInflight.delete(documentId)))
    }
    return ensureInflight.get(documentId)
  },
  extractions: (claimId) => api.get(`/claims/${claimId}/automation/extractions`).then((r) => r.data),
  applyExtraction: (runId, fields) => api.post(`/automation/extractions/${runId}/apply`, { fields }).then((r) => r.data),
  discardExtraction: (runId) => api.post(`/automation/extractions/${runId}/discard`).then((r) => r.data),
  summary: (claimId) => api.get(`/claims/${claimId}/automation/summary`).then((r) => r.data),
  generateSummary: (claimId) => api.post(`/claims/${claimId}/automation/summary`).then((r) => r.data),
  // Claim agents (coverage, triage, reserve, denial letter, payee, subrogation)
  agentRuns: (claimId, agent) => api.get(`/claims/${claimId}/agents/${agent}`).then((r) => r.data),
  runAgent: (claimId, agent) => api.post(`/claims/${claimId}/agents/${agent}`).then((r) => r.data),
  applyAgentRun: (runId, body) => api.post(`/agent-runs/${runId}/apply`, body).then((r) => r.data),
  discardAgentRun: (runId, reason) => api.post(`/agent-runs/${runId}/discard`, reason ? { reason } : {}).then((r) => r.data),
  // Beacon AI Image Forensics (local checks on image documents)
  acceptRunImageAlert: (runId) => api.post(`/ai-runs/${runId}/image-alert/accept`).then((r) => r.data),
  documentImageForensics: (documentId) => api.get(`/documents/${documentId}/image-forensics`).then((r) => r.data),
  acceptDocumentImageAlert: (documentId) => api.post(`/documents/${documentId}/image-forensics/accept`).then((r) => r.data),
}
