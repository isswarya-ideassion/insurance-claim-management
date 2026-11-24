import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input.js'
import { useDebouncedField } from '@/hooks/useDebounce.js'
import { cn } from '@/lib/utils.js'

/** Search box that updates the list only after the user pauses typing. */
export function SearchInput({ value = '', onChange, placeholder = 'Search…', className, label = 'Search', delayMs = 350 }) {
  const [text, setText] = useDebouncedField(value, onChange, delayMs)

  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input type="search" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pl-8 pr-8" />
      {text && (
        <button type="button" onClick={() => setText('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * An <Input> for a list filter (dates, references): typing updates the field
 * at once, the filter (and its query) only after a pause.
 */
export function DebouncedInput({ value = '', onValueChange, delayMs = 400, ...props }) {
  const [text, setText] = useDebouncedField(value, onValueChange, delayMs)
  return <Input {...props} value={text} onChange={(e) => setText(e.target.value)} />
}
