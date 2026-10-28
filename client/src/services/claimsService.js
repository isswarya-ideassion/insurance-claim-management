import { api } from './apiClient.js'

export const claimsService = {
  list: (params) => api.get('/claims', params),
  stats: () => api.get('/claims/stats').then((r) => r.data),
  get: (id) => api.get(`/claims/${id}`).then((r) => r.data),
  createDraft: (body) => api.post('/claims', body).then((r) => r.data),
  updateDraft: (id, body) => api.patch(`/claims/${id}`, body).then((r) => r.data),
  updateMeta: (id, body) => api.patch(`/claims/${id}`, body).then((r) => r.data),
  discardDraft: (id) => api.delete(`/claims/${id}`).then((r) => r.data),
  submit: (id, body) => api.post(`/claims/${id}/submit`, body),
  transitions: (id) => api.get(`/claims/${id}/transitions`).then((r) => r.data),
  transition: (id, body) => api.post(`/claims/${id}/transitions`, body).then((r) => r.data),
  verifyPolicy: (id, body) => api.post(`/claims/${id}/verify-policy`, body).then((r) => r.data),
  updateChecklist: (id, items) => api.patch(`/claims/${id}/intake-checklist`, { items }).then((r) => r.data),
  escalate: (id, reason) => api.post(`/claims/${id}/escalate`, { reason }).then((r) => r.data),
  documentException: (id, reason) => api.post(`/claims/${id}/document-exception`, { reason }).then((r) => r.data),
  notes: (id) => api.get(`/claims/${id}/notes`).then((r) => r.data),
  addNote: (id, body) => api.post(`/claims/${id}/notes`, body).then((r) => r.data),
  timeline: (id) => api.get(`/claims/${id}/timeline`).then((r) => r.data),
  assignments: (id) => api.get(`/claims/${id}/assignments`).then((r) => r.data),
  assign: (id, body) => api.post(`/claims/${id}/assignments`, body).then((r) => r.data),
  assignees: (role) => api.get('/assignments/assignees', { role }).then((r) => r.data),
  workload: () => api.get('/assignments/workload').then((r) => r.data),
}

export const policiesService = {
  list: (params) => api.get('/policies', params),
  get: (id) => api.get(`/policies/${id}`).then((r) => r.data),
  eligibility: (body) => api.post('/policies/eligibility', body).then((r) => r.data),
}
