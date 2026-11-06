import { cn } from '@/lib/utils.js'

const TONES = {
  neutral: 'border-border bg-muted/40 text-muted-foreground',
  danger: 'border-red-200 bg-red-50/70 text-red-900',
}

/**
 * An inline status message: "waiting for someone", "not available here", "this failed".
 * `danger` is for real failures only; everything expected uses `neutral`.
 * Errors get role="alert" so screen readers announce them; the rest role="status".
 */
export function Notice({ tone = 'neutral', icon: Icon, title, children, className }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-lg border p-3 text-sm', TONES[tone], className)}>
      {Icon && <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 space-y-1">
        {title && <p className={cn('font-medium', tone === 'neutral' && 'text-foreground')}>{title}</p>}
        {children}
      </div>
    </div>
  )
}
