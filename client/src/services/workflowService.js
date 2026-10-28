import { api } from './apiClient.js'

export const tasksService = {
  list: (params) => api.get('/tasks', params),
  forClaim: (claimId) => api.get(`/claims/${claimId}/tasks`).then((r) => r.data),
  create: (body) => api.post('/tasks', body).then((r) => r.data),
  update: (id, body) => api.patch(`/tasks/${id}`, body).then((r) => r.data),
}

export const evaluationsService = {
  list: (claimId) => api.get(`/claims/${claimId}/evaluations`).then((r) => r.data),
  create: (claimId, body = {}) => api.post(`/claims/${claimId}/evaluations`, body).then((r) => r.data),
  update: (id, body) => api.patch(`/evaluations/${id}`, body).then((r) => r.data),
  submit: (id, body) => api.post(`/evaluations/${id}/submit`, body).then((r) => r.data),
  returnForCorrection: (id, comment) => api.post(`/evaluations/${id}/return`, { comment }).then((r) => r.data),
}

export const approvalsService = {
  claimReserves: (claimId) => api.get(`/claims/${claimId}/reserves`).then((r) => r.data),
  reserveQueue: (params) => api.get('/reserves/queue', params),
  reviewReserve: (id, body) => api.post(`/reserves/${id}/review`, body).then((r) => r.data),
  reviseReserve: (claimId, body) => api.post(`/claims/${claimId}/reserves`, body).then((r) => r.data),
  claimSettlements: (claimId) => api.get(`/claims/${claimId}/settlements`).then((r) => r.data),
  settlementQueue: (params) => api.get('/settlements/queue', params),
  decideSettlement: (id, body) => api.post(`/settlements/${id}/approvals`, body).then((r) => r.data),
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
  issue: (id, idempotencyKey) => api.post(`/payments/${id}/issue`, {}, { headers: { 'Idempotency-Key': idempotencyKey } }),
  resolveBlock: (id, resolution) => api.post(`/payments/${id}/resolve-block`, { resolution }).then((r) => r.data),
  verifyPayee: (payeeId, notes) => api.post(`/payees/${payeeId}/verify`, { notes }).then((r) => r.data),
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

export const closureService = {
  requests: (claimId) => api.get(`/claims/${claimId}/closure-requests`).then((r) => r.data),
  request: (claimId, reason) => api.post(`/claims/${claimId}/closure-requests`, { reason }).then((r) => r.data),
  decide: (id, body) => api.post(`/closure-requests/${id}/decision`, body).then((r) => r.data),
  recoveries: (claimId) => api.get(`/claims/${claimId}/recoveries`).then((r) => r.data),
  createRecovery: (claimId, body) => api.post(`/claims/${claimId}/recoveries`, body).then((r) => r.data),
  updateRecovery: (id, body) => api.patch(`/recoveries/${id}`, body).then((r) => r.data),
}

export const configService = {
  segments: () => api.get('/config/segments').then((r) => r.data),
  propose: (body) => api.post('/config/segments', body).then((r) => r.data),
  decide: (id, body) => api.post(`/config/segments/${id}/decision`, body).then((r) => r.data),
  authorityLimits: () => api.get('/config/authority-limits').then((r) => r.data),
  fraudReasonCodes: () => api.get('/config/fraud-reason-codes').then((r) => r.data),
}

export const integrationsService = {
  runs: (params) => api.get('/integrations/runs', params),
  recordRun: (body) => api.post('/integrations/runs', body).then((r) => r.data),
  xref: (params) => api.get('/integrations/xref', params),
  linkXref: (body) => api.post('/integrations/xref', body).then((r) => r.data),
  precedence: () => api.get('/integrations/source-precedence').then((r) => r.data),
  setPrecedence: (body) => api.put('/integrations/source-precedence', body).then((r) => r.data),
}

export const reportsService = {
  summary: (params) => api.get('/reports/summary', params).then((r) => r.data),
}

export const auditService = {
  list: (params) => api.get('/audit-logs', params),
  verify: () => api.get('/audit-logs/verify').then((r) => r.data),
}

export const adminService = {
  users: (params) => api.get('/admin/users', params),
  roles: () => api.get('/admin/roles').then((r) => r.data),
  createUser: (body) => api.post('/admin/users', body).then((r) => r.data),
  grantRole: (id, body) => api.post(`/admin/users/${id}/roles`, body).then((r) => r.data),
  setAttributes: (id, body) => api.put(`/admin/users/${id}/attributes`, body).then((r) => r.data),
  revokeRole: (id, roleCode) => api.delete(`/admin/users/${id}/roles/${roleCode}`).then((r) => r.data),
  setActive: (id, isActive) => api.patch(`/admin/users/${id}`, { isActive }).then((r) => r.data),
  overdueSweep: () => api.post('/admin/jobs/overdue-sweep').then((r) => r.data),
  system: () => api.get('/admin/system').then((r) => r.data),
}

export const healthService = {
  check: () => api.get('/health').then((r) => r.data),
}
