import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { api, inflightRequestCount, withRequestSignal } from '@/services/apiClient.js'
import { automationService } from '@/services/automationService.js'
import { useApiQuery } from '@/hooks/useApi.js'

/** fetch double whose responses are released by hand, so requests stay "in flight". */
function deferredFetch() {
  const calls = []
  const fetchMock = vi.fn((url, init) => {
    let release
    const promise = new Promise((resolve, reject) => {
      release = (body = { data: { url } }) => resolve(new Response(JSON.stringify(body), { status: 200 }))
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    calls.push({ url, init, release })
    return promise
  })
  return { fetchMock, calls }
}

let net
beforeEach(() => {
  net = deferredFetch()
  vi.stubGlobal('fetch', net.fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('apiClient GET de-duplication', () => {
  it('shares one request between identical concurrent GETs', async () => {
    const a = api.get('/claims/1', { tab: 'x' })
    const b = api.get('/claims/1', { tab: 'x' })
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(1)
    net.calls[0].release({ data: { id: 1 } })
    expect(await a).toEqual({ data: { id: 1 } })
    expect(await b).toEqual({ data: { id: 1 } })
    expect(inflightRequestCount()).toBe(0)
  })

  it('keeps different queries and later GETs separate', async () => {
    api.get('/claims/1', { tab: 'x' })
    api.get('/claims/1', { tab: 'y' })
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(2)
    net.calls.forEach((c) => c.release())
    await flush()
    api.get('/claims/1', { tab: 'x' })
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(3)
    net.calls[2].release()
  })

  it('never shares writes, and a write retires reads started before it', async () => {
    const before = api.get('/claims/1')
    api.post('/claims/1/notes', { body: 'a' })
    api.post('/claims/1/notes', { body: 'a' })
    await flush()
    expect(net.fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(2)
    net.calls[1].release()
    await flush()
    // The GET in flight before the write is not reused for a read after it.
    api.get('/claims/1')
    await flush()
    expect(net.fetchMock.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(2)
    net.calls.forEach((c) => c.release())
    await before
  })

  it('aborts the shared request only when every caller has cancelled', async () => {
    const one = new AbortController()
    const two = new AbortController()
    const a = withRequestSignal(one.signal, () => api.get('/claims/2'))
    const b = withRequestSignal(two.signal, () => api.get('/claims/2'))
    await flush()
    one.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(net.calls[0].init.signal.aborted).toBe(false)
    two.abort()
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(net.calls[0].init.signal.aborted).toBe(true)
  })

  it('lets a caller that cancels and immediately re-subscribes rejoin the same request (StrictMode remount)', async () => {
    const first = new AbortController()
    const a = withRequestSignal(first.signal, () => api.get('/claims/3'))
    first.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const b = api.get('/claims/3')
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(1)
    net.calls[0].release({ data: 'ok' })
    expect(await b).toEqual({ data: 'ok' })
  })
})

describe('auto-triggered scan POST', () => {
  it('sends one ensure-extraction POST per document however many callers ask at once', async () => {
    const a = automationService.ensureExtraction('doc-1')
    const b = automationService.ensureExtraction('doc-1')
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(1)
    net.calls[0].release({ data: { run: null } })
    expect(await a).toEqual({ run: null })
    expect(await b).toBe(await a)
  })
})

describe('useApiQuery under StrictMode', () => {
  function Probe({ id }) {
    const q = useApiQuery(() => api.get(`/claims/${id}`), [id])
    return <p>{q.data ? `loaded ${q.data.id}` : q.error ? `error ${q.error.name}` : 'loading'}</p>
  }

  it('fetches once on mount and shows no error for the simulated unmount', async () => {
    render(
      <StrictMode>
        <Probe id="9" />
      </StrictMode>,
    )
    await flush()
    expect(net.fetchMock).toHaveBeenCalledTimes(1)
    net.calls[0].release({ data: { id: '9' } })
    await waitFor(() => expect(screen.getByText('loaded 9')).toBeInTheDocument())
  })

  it('cancels the request when the component unmounts', async () => {
    const view = render(<Probe id="10" />)
    await flush()
    view.unmount()
    await flush()
    await flush()
    expect(net.calls[0].init.signal.aborted).toBe(true)
  })
})
