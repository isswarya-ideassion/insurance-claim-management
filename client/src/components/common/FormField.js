import { cloneElement, isValidElement, useId } from 'react'
import { Label } from '@/components/ui/input.js'
import { cn } from '@/lib/utils.js'

/** Accessible label + control + hint/error wrapper. The child control receives id and aria attributes. */
export function FormField({ label, error, hint, required, children, className }) {
  const id = useId()
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': describedBy, 'aria-required': required || undefined })
    : children
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
        </Label>
      )}
      {control}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function KeyValue({ items, columns = 2, className }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4', columns === 3 ? 'sm:grid-cols-3' : columns === 1 ? '' : 'sm:grid-cols-2', className)}>
      {items.filter(Boolean).map((item) => (
        <div key={item.label} className={cn('min-w-0', item.wide && 'sm:col-span-full')}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 break-words text-sm text-foreground">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SectionCard({ title, description, actions, children, className, bodyClassName }) {
  return (
    // min-w-0 lets a card shrink inside grid and flex layouts, so wide tables scroll within the card instead of widening the page.
    <section className={cn('min-w-0 rounded-xl border bg-card shadow-sm', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  )
}
