import { forwardRef } from 'react'
import { cn } from '@/lib/utils.js'
import { Input } from '@/components/ui/input.js'

/** Keeps at most 10 digits (a pasted +91 or leading 0 is dropped), shown as "98765 43210". */
export function formatLocalMobile(value) {
  let digits = String(value || '').replace(/\D/g, '')
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2)
  if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1)
  digits = digits.slice(0, 10)
  return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits
}

/**
 * Indian mobile number: a fixed +91 prefix and the 10-digit number.
 * The field value is the 10 digits; send it through normalizeIndianMobile().
 */
export const PhoneInput = forwardRef(function PhoneInput({ className, onChange, ...props }, ref) {
  return (
    <div className={cn('flex', className)}>
      <span className="inline-flex h-9 items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground" aria-hidden="true">
        +91
      </span>
      <Input
        ref={ref}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder="98765 43210"
        className="rounded-l-none"
        onChange={(e) => {
          e.target.value = formatLocalMobile(e.target.value)
          onChange?.(e)
        }}
        {...props}
      />
    </div>
  )
})
