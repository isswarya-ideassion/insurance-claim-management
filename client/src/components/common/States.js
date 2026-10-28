import { AlertTriangle, Inbox, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button.js'
import { Skeleton } from '@/components/ui/misc.js'
import { cn } from '@/lib/utils.js'

export function EmptyState({ icon: Icon = Inbox, title = 'Nothing here yet', description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/60 px-6 py-12 text-center', className)}>
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, className, title }) {
  const forbidden = error?.status === 403
  const Icon = forbidden ? ShieldAlert : AlertTriangle
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-2 rounded-xl border border-red-200 bg-red-50/60 px-6 py-10 text-center', className)}>
      <Icon className="size-6 text-red-600" aria-hidden="true" />
      <p className="font-medium text-red-900">{title || (forbidden ? 'You do not have access to this information' : 'Something went wrong')}</p>
      <p className="max-w-md text-sm text-red-800/80">{error?.message || 'The request could not be completed.'}</p>
      {error?.requestId && <p className="text-xs text-red-800/60">Reference: {error.requestId}</p>}
      {onRetry && !forbidden && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-2">
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  )
}

export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cn('h-6', c === 0 ? 'w-28' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  )
}

export function CardsSkeleton({ count = 4 }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-28 rounded-xl" />
      ))}
    </div>
  )
}

export function BlockSkeleton({ className }) {
  return <Skeleton className={cn('h-64 w-full rounded-xl', className)} aria-busy="true" aria-label="Loading" />
}

/** Renders loading / error / empty / content for a query result. */
export function QueryState({ query, empty, skeleton, children, isEmpty }) {
  if (query.loading && !query.data) return skeleton || <BlockSkeleton />
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={query.reload} />
  const emptyNow = isEmpty ? isEmpty(query.data) : Array.isArray(query.data) && query.data.length === 0
  if (emptyNow && empty) return empty
  return children(query.data, query.meta)
}
