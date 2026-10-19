import { api } from './apiClient.js'

export const tasksService = {
  list: (params) => api.get('/tasks', params),
  forClaim: (claimId) => api.get(`/claims/${claimId}/tasks`).then((r) => r.data),
  create: (body) => api.post('/tasks', body).then((r) => r.data),
  update: (id, body) => api.patch(`/tasks/${id}`, body).then((r) => r.data),
}

export const assessmentsService = {
  list: (claimId) => api.get(`/claims/${claimId}/assessments`).then((r) => r.data),
  create: (claimId, body = {}) => api.post(`/claims/${claimId}/assessments`, body).then((r) => r.data),
  update: (id, body) => api.patch(`/assessments/${id}`, body).then((r) => r.data),
  submit: (id, body) => api.post(`/assessments/${id}/submit`, body).then((r) => r.data),
  returnForCorrection: (id, comment) => api.post(`/assessments/${id}/return`, { comment }).then((r) => r.data),
}

export const approvalsService = {
  claimReserves: (claimId) => api.get(`/claims/${claimId}/reserves`).then((r) => r.data),
  reserveQueue: (params) => api.get('/reserves/queue', params),
  decideReserve: (id, body) => api.post(`/reserves/${id}/decision`, body).then((r) => r.data),
  claimSettlements: (claimId) => api.get(`/claims/${claimId}/settlements`).then((r) => r.data),
  settlementQueue: (params) => api.get('/settlements/queue', params),
  decideSettlement: (id, body) => api.post(`/settlements/${id}/decision`, body).then((r) => r.data),
  claimApprovals: (claimId) => api.get(`/claims/${claimId}/approvals`).then((r) => r.data),
  history: (params) => api.get('/approvals', params),
}

export const complianceService = {
  queue: (params) => api.get('/compliance/queue', params),
  forClaim: (claimId) => api.get(`/claims/${claimId}/compliance-reviews`).then((r) => r.data),
  open: (claimId, body) => api.post(`/claims/${claimId}/compliance-reviews`, body).then((r) => r.data),
  update: (id, body) => api.patch(`/compliance-reviews/${id}`, body).then((r) => r.data),
  decide: (id, body) => api.post(`/compliance-reviews/${id}/decision`, body).then((r) => r.data),
}

export const paymentsService = {
  list: (params) => api.get('/payments', params),
  get: (id) => api.get(`/payments/${id}`).then((r) => r.data),
  forClaim: (claimId) => api.get(`/claims/${claimId}/payments`).then((r) => r.data),
  claimStatus: (claimId) => api.get(`/claims/${claimId}/payment-status`).then((r) => r.data),
  mine: () => api.get('/payments/mine').then((r) => r.data),
  beneficiary: (id) => api.get(`/payments/${id}/beneficiary`).then((r) => r.data),
  process: (id, idempotencyKey) => api.post(`/payments/${id}/process`, {}, { headers: { 'Idempotency-Key': idempotencyKey } }),
  retry: (id, reason) => api.post(`/payments/${id}/retry`, { reason }).then((r) => r.data),
  updateBeneficiary: (id, body) => api.patch(`/payments/${id}/beneficiary`, body).then((r) => r.data),
  reconcile: (id, body) => api.post(`/payments/${id}/reconcile`, body).then((r) => r.data),
  reconciliation: () => api.get('/payments/reconciliation/summary').then((r) => r.data),
}

export const notificationsService = {
  list: (params) => api.get('/notifications', params),
  unreadCount: () => api.get('/notifications/unread-count').then((r) => r.data.unread),
  markRead: (id) => api.post(`/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () => api.post('/notifications/read-all').then((r) => r.data),
}

export const reportsService = {
  summary: (params) => api.get('/reports/summary', params).then((r) => r.data),
}

export const auditService = {
  list: (params) => api.get('/audit-logs', params),
}

export const adminService = {
  users: (params) => api.get('/admin/users', params),
  roles: () => api.get('/admin/roles').then((r) => r.data),
  createUser: (body) => api.post('/admin/users', body).then((r) => r.data),
  grantRole: (id, body) => api.post(`/admin/users/${id}/roles`, body).then((r) => r.data),
  revokeRole: (id, roleCode) => api.delete(`/admin/users/${id}/roles/${roleCode}`).then((r) => r.data),
  setActive: (id, isActive) => api.patch(`/admin/users/${id}`, { isActive }).then((r) => r.data),
  overdueSweep: () => api.post('/admin/jobs/overdue-sweep').then((r) => r.data),
  system: () => api.get('/admin/system').then((r) => r.data),
}

export const healthService = {
  check: () => api.get('/health').then((r) => r.data),
}
