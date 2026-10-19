import { api } from './apiClient.js'

export const documentsService = {
  list: (claimId) => api.get(`/claims/${claimId}/documents`).then((r) => r.data),
  upload: (claimId, { file, category, informationRequestId, replacesDocumentId }) => {
    const form = new FormData()
    form.append('category', category)
    if (informationRequestId) form.append('informationRequestId', informationRequestId)
    if (replacesDocumentId) form.append('replacesDocumentId', replacesDocumentId)
    form.append('file', file)
    return api.upload(`/claims/${claimId}/documents`, form).then((r) => r.data)
  },
  download: (id, disposition = 'attachment') => api.blob(`/documents/${id}/download`, { disposition }),
  versions: (id) => api.get(`/documents/${id}/versions`).then((r) => r.data),
  reviewQueue: (params) => api.get('/documents/review-queue', params),
  review: (id, body) => api.post(`/documents/${id}/review`, body).then((r) => r.data),
  assignReviewer: (id, reviewerId) => api.post(`/documents/${id}/assign-reviewer`, { reviewerId }).then((r) => r.data),

  claimRequests: (claimId) => api.get(`/claims/${claimId}/information-requests`).then((r) => r.data),
  requests: (params) => api.get('/information-requests', params),
  createRequest: (claimId, body) => api.post(`/claims/${claimId}/information-requests`, body).then((r) => r.data),
  respond: (id, responseText) => api.post(`/information-requests/${id}/respond`, { responseText }).then((r) => r.data),
  closeRequest: (id) => api.post(`/information-requests/${id}/close`).then((r) => r.data),
}

/** Saves a downloaded blob through a temporary object URL (never a public storage URL). */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
