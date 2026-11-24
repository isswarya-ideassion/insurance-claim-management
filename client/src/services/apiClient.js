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
  } finally {
    // A write may change what any GET returns: reads started before it are no
    // longer shared, so a reload after a save always fetches fresh data.
    if (method !== 'GET') inflight.clear()
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

// ---------------------------------------------------------------------------
// GET de-duplication and cancellation
// ---------------------------------------------------------------------------
// Identical GETs in flight at the same time (same URL and query) share one
// network request: React StrictMode's double effects, and several components
// mounting with the same data, no longer hit the server twice. Each caller can
// still cancel with its own AbortSignal; the shared request is aborted only
// when every caller has gone, and only after the current task, so a StrictMode
// unmount + remount rejoins the request instead of cancelling and repeating it.
const inflight = new Map()

// The signal of the query currently being started (see withRequestSignal).
let ambientSignal = null

/**
 * Runs `fn` with `signal` applied to every GET it starts synchronously, so a
 * hook can cancel a service call without each service threading a signal.
 */
export function withRequestSignal(signal, fn) {
  const previous = ambientSignal
  ambientSignal = signal
  try {
    return fn()
  } finally {
    ambientSignal = previous
  }
}

const abortError = () => new DOMException('The request was cancelled', 'AbortError')

function leave(key, entry) {
  entry.waiters -= 1
  if (entry.waiters > 0) return
  setTimeout(() => {
    if (entry.waiters === 0 && inflight.get(key) === entry) {
      inflight.delete(key)
      entry.controller.abort()
    }
  }, 0)
}

function sharedGet(path, { params, signal = ambientSignal, ...opts } = {}) {
  if (signal?.aborted) return Promise.reject(abortError())
  const key = buildUrl(path, params)
  let entry = inflight.get(key)
  if (!entry) {
    const controller = new AbortController()
    entry = { controller, waiters: 0, promise: null }
    const created = entry
    entry.promise = request('GET', path, { ...opts, params, signal: controller.signal }).finally(() => {
      if (inflight.get(key) === created) inflight.delete(key)
    })
    inflight.set(key, entry)
  }
  const shared = entry
  shared.waiters += 1
  if (!signal) {
    // An uncancellable caller keeps the request alive until it settles.
    return shared.promise
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError())
      leave(key, shared)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Test hook: requests currently shared. */
export const inflightRequestCount = () => inflight.size

export const api = {
  get: (path, params, opts) => sharedGet(path, { ...opts, params }),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, opts),
  upload: (path, formData) => request('POST', path, { body: formData }),
  // Downloads are never shared (each caller consumes its own body) but honour a signal like any GET.
  blob: async (path, params, { signal = ambientSignal } = {}) => {
    const res = await request('GET', path, { params, raw: true, signal })
    return res.blob()
  },
}

/** Unwraps { data, meta } envelopes. */
export const data = (promise) => promise.then((r) => r.data)
