import { API_URL } from '@/constants/config.js'

export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message || 'Request failed')
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
    this.requestId = requestId
  }
}

let tokenProvider = async () => null
let unauthorizedHandler = () => {}

export function configureApiClient({ getToken, onUnauthorized }) {
  if (getToken) tokenProvider = getToken
  if (onUnauthorized) unauthorizedHandler = onUnauthorized
}

function buildUrl(path, params) {
  const url = `${API_URL}${path}`
  if (!params) return url
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    search.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const qs = search.toString()
  return qs ? `${url}?${qs}` : url
}

async function request(method, path, { params, body, headers = {}, raw = false, signal } = {}) {
  const token = await tokenProvider()
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal }
  if (token) init.headers.Authorization = `Bearer ${token}`
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(buildUrl(path, params), init)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Cannot reach the claims API. Check that the server is running.' })
  }

  if (raw && res.ok) return res

  let payload = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!res.ok) {
    const error = new ApiError({
      status: res.status,
      code: payload?.error?.code || 'HTTP_ERROR',
      message: payload?.error?.message || `Request failed (${res.status})`,
      details: payload?.error?.details,
      requestId: payload?.error?.requestId,
    })
    if (res.status === 401 && token) unauthorizedHandler(error)
    throw error
  }
  return payload ?? {}
}

export const api = {
  get: (path, params, opts) => request('GET', path, { ...opts, params }),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, opts),
  upload: (path, formData) => request('POST', path, { body: formData }),
  blob: async (path, params) => {
    const res = await request('GET', path, { params, raw: true })
    return res.blob()
  },
}

/** Unwraps { data, meta } envelopes. */
export const data = (promise) => promise.then((r) => r.data)
