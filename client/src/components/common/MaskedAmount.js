import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { CURRENCY_SYMBOL } from '@shared/constants.js'
import { formatMoney } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

/**
 * A confidential amount (a settlement or payout) hidden until the viewer
 * chooses to show it, so it is not exposed on a shared or visible screen.
 */
export function MaskedAmount({ value, label = 'amount', className }) {
  const [shown, setShown] = useState(false)
  if (value === null || value === undefined || value === '') return <span className={className}>—</span>
  const Icon = shown ? EyeOff : Eye
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="tabular" aria-live="polite">
        {shown ? formatMoney(value) : <><span>{CURRENCY_SYMBOL} •••••</span><span className="sr-only">{`${label} hidden`}</span></>}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setShown((s) => !s)
        }}
        aria-pressed={shown}
        aria-label={shown ? `Hide ${label}` : `Show ${label}`}
        title={shown ? `Hide ${label}` : `Show ${label}`}
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </span>
  )
}
