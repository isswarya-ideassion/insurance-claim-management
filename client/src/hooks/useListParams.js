import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Keeps list state (page, filters, sort) in the URL so views are shareable
 * and survive refreshes.
 */
export function useListParams(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams()

  const params = useMemo(() => {
    const out = { page: 1, pageSize: 20, ...defaults }
    for (const [k, v] of searchParams.entries()) out[k] = ['page', 'pageSize'].includes(k) ? Number(v) : v
    return out
  }, [searchParams])

  const setParams = useCallback(
    (patch, { resetPage = true } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) next.delete(k)
            else next.set(k, Array.isArray(v) ? v.join(',') : String(v))
          }
          if (resetPage && !('page' in patch)) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const reset = useCallback(() => setSearchParams({}, { replace: true }), [setSearchParams])

  return { params, setParams, reset }
}
