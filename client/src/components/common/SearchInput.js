import { useEffect, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input.js'
import { useDebounce } from '@/hooks/useApi.js'
import { cn } from '@/lib/utils.js'

export function SearchInput({ value = '', onChange, placeholder = 'Search…', className, label = 'Search' }) {
  const [text, setText] = useState(value)
  const debounced = useDebounce(text, 350)

  useEffect(() => setText(value), [value])
  useEffect(() => {
    if (debounced !== value) onChange(debounced)
  }, [debounced])

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
