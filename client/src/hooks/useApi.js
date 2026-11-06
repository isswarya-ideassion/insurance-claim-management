import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

/**
 * Loads data from an async function and re-runs when deps change.
 * Returns { data, meta, error, loading, reload, setData }.
 */
export function useApiQuery(fn, deps = [], { enabled = true, keepPrevious = true } = {}) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: enabled })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const seq = useRef(0)

  const run = useCallback(async () => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null, data: keepPrevious ? s.data : null }))
    try {
      const result = await fnRef.current()
      if (id !== seq.current) return
      const isEnvelope = result && typeof result === 'object' && 'data' in result && !Array.isArray(result)
      setState({
        data: isEnvelope ? result.data : result,
        meta: isEnvelope ? result.meta || null : null,
        error: null,
        loading: false,
      })
    } catch (error) {
      if (id !== seq.current) return
      setState((s) => ({ ...s, error, loading: false }))
    }
  }, [keepPrevious])

  useEffect(() => {
    if (enabled) run()
  }, [enabled, ...deps])

  const setData = useCallback((updater) => {
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }))
  }, [])

  return { ...state, reload: run, setData }
}

/** Wraps a mutation with pending state and toast feedback. */
export function useAction() {
  const [pending, setPending] = useState(false)
  const run = useCallback(async (fn, { success, error: errorMessage, rethrow = false } = {}) => {
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
    }
  }, [])
  return { pending, run }
}

export function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
