import { api } from './apiClient.js'

export const customersService = {
  list: (params) => api.get('/customers', params),
  get: (id) => api.get(`/customers/${id}`).then((r) => r.data),
  exportCsv: (params) => api.blob('/customers/export', params),
  downloadDocument: (customerId, documentId, disposition = 'attachment') =>
    api.blob(`/customers/${customerId}/documents/${documentId}/download`, { disposition }),
}

export const automationService = {
  status: () => api.get('/automation/status').then((r) => r.data),
  documentChecklist: (claimId) => api.get(`/claims/${claimId}/automation/document-checklist`).then((r) => r.data),
  createReminderDraft: (claimId, body = {}) => api.post(`/claims/${claimId}/automation/reminder-drafts`, body).then((r) => r.data),
  claimReminders: (claimId) => api.get(`/claims/${claimId}/automation/reminders`).then((r) => r.data),
  reminders: (params) => api.get('/automation/reminders', params),
  approveReminder: (id, message) => api.post(`/automation/reminders/${id}/approve`, message ? { message } : {}).then((r) => r.data),
  discardReminder: (id) => api.post(`/automation/reminders/${id}/discard`).then((r) => r.data),
  runReminderSweep: () => api.post('/automation/reminders/sweep').then((r) => r.data),
  extract: (documentId) => api.post(`/documents/${documentId}/extractions`).then((r) => r.data),
  extractions: (claimId) => api.get(`/claims/${claimId}/automation/extractions`).then((r) => r.data),
  applyExtraction: (runId, fields) => api.post(`/automation/extractions/${runId}/apply`, { fields }).then((r) => r.data),
  discardExtraction: (runId) => api.post(`/automation/extractions/${runId}/discard`).then((r) => r.data),
  summary: (claimId) => api.get(`/claims/${claimId}/automation/summary`).then((r) => r.data),
  generateSummary: (claimId) => api.post(`/claims/${claimId}/automation/summary`).then((r) => r.data),
}
