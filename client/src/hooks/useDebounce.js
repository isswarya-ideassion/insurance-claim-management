import { useEffect, useRef, useState } from 'react'

/** `value`, updated only after it has stopped changing for `delayMs`. */
export function useDebounce(value, delayMs = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

/**
 * Local text state for a filter input that commits to `onCommit` only once the
 * user pauses typing, so a query (and its API call) runs once per edit, not
 * once per keystroke. External changes to `value` (reset, back button) are
 * reflected immediately and never echoed back as a commit.
 */
export function useDebouncedField(value, onCommit, delayMs = 300) {
  const [text, setText] = useState(value)
  const debounced = useDebounce(text, delayMs)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const external = useRef(value)

  useEffect(() => {
    external.current = value
    setText(value)
  }, [value])

  useEffect(() => {
    if (debounced !== external.current) commitRef.current(debounced)
  }, [debounced])

  return [text, setText]
}
