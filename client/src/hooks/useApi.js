import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { withRequestSignal } from '@/services/apiClient.js'

/**
 * Loads data from an async function and re-runs when deps change.
 * Returns { data, meta, error, loading, reload, setData }.
 *
 * Every load owns an AbortController and a `cancelled` closure flag: when the
 * deps change, the component unmounts (including StrictMode's simulated
 * unmount) or a newer load starts, the stale request is aborted and its result
 * can never reach setState. GETs started synchronously inside `fn` receive the
 * signal through withRequestSignal (see apiClient), so services need no changes.
 */
export function useApiQuery(fn, deps = [], { enabled = true, keepPrevious = true } = {}) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: enabled })
  const fnRef = useRef(fn)
  fnRef.current = fn
  // Cancels whichever load is current (effect-started or a manual reload).
  const cancelCurrent = useRef(() => {})

  const load = useCallback(
    async (signal, isCancelled) => {
      setState((s) => ({ ...s, loading: true, error: null, data: keepPrevious ? s.data : null }))
      try {
        const result = await withRequestSignal(signal, () => fnRef.current())
        if (isCancelled()) return
        const isEnvelope = result && typeof result === 'object' && 'data' in result && !Array.isArray(result)
        setState({
          data: isEnvelope ? result.data : result,
          meta: isEnvelope ? result.meta || null : null,
          error: null,
          loading: false,
        })
      } catch (error) {
        // Cancelled on purpose (unmount, new deps, newer load): nothing to show.
        if (isCancelled() || error?.name === 'AbortError') return
        setState((s) => ({ ...s, error, loading: false }))
      }
    },
    [keepPrevious],
  )

  /** Starts a load that supersedes any load in flight; returns its cancel function. */
  const start = useCallback(() => {
    cancelCurrent.current()
    let cancelled = false
    const controller = new AbortController()
    const cancel = () => {
      cancelled = true
      controller.abort()
    }
    cancelCurrent.current = cancel
    const done = load(controller.signal, () => cancelled)
    return { cancel, done }
  }, [load])

  useEffect(() => {
    if (!enabled) return undefined
    const { cancel } = start()
    return cancel
  }, [enabled, ...deps])

  // A manual reload started after the last effect is cancelled on unmount too.
  useEffect(() => () => cancelCurrent.current(), [])

  const reload = useCallback(() => start().done, [start])

  const setData = useCallback((updater) => {
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }))
  }, [])

  return { ...state, reload, setData }
}

/**
 * Wraps a mutation with pending state and toast feedback.
 *
 * With `{ lock: true }` a second call while one is in flight (a double click
 * that lands before the re-render disables the button) is ignored and returns
 * undefined; `cooldownMs` keeps the lock for a moment after it settles.
 */
export function useAction({ lock = false, cooldownMs = 0 } = {}) {
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const run = useCallback(async (fn, { success, error: errorMessage, rethrow = false } = {}) => {
    if (lock && busy.current) return undefined
    busy.current = true
    setPending(true)
    try {
      const result = await fn()
      if (success) toast.success(typeof success === 'function' ? success(result) : success)
      // Success must be distinguishable from failure (which returns undefined). Many callers run a
      // void action such as `async () => { await save(); await reload() }` and close a dialog on a
      // truthy result; returning its undefined left those dialogs open after a successful submit.
      // An API that answers with `data: null` is a success too.
      return result ?? true
    } catch (err) {
      // An intentionally cancelled request is not a failure.
      if (err?.name === 'AbortError') return undefined
      // Validation errors carry the list of problems (field + message); show them so the user knows what to fix.
      const problems = Array.isArray(err.details) ? err.details.map((d) => d.message).filter(Boolean) : []
      const lines = [...problems, err.requestId ? `Reference: ${err.requestId}` : null].filter(Boolean)
      toast.error(errorMessage || err.message || 'Something went wrong', {
        description: lines.length ? lines.join('\n') : undefined,
      })
      if (rethrow) throw err
      return undefined
    } finally {
      setPending(false)
      if (cooldownMs > 0) setTimeout(() => (busy.current = false), cooldownMs)
      else busy.current = false
    }
  }, [lock, cooldownMs])
  return { pending, run }
}

// Kept here for existing imports; the hook lives in hooks/useDebounce.js.
export { useDebounce } from './useDebounce.js'
