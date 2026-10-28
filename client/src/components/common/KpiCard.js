import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils.js'

const TONES = {
  navy: 'bg-blue-50 text-blue-700',
  teal: 'bg-teal-50 text-teal-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  green: 'bg-emerald-50 text-emerald-700',
  slate: 'bg-slate-100 text-slate-600',
  violet: 'bg-violet-50 text-violet-700',
}

export function KpiCard({ label, value, icon: Icon, tone = 'navy', hint, to, index = 0 }) {
  const body = (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.03 }}
      className={cn('group flex h-full items-start justify-between gap-3 rounded-xl border bg-card p-4 shadow-sm', to && 'transition-shadow hover:border-accent/40 hover:shadow-md')}
    >
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="tabular mt-1.5 text-2xl font-semibold text-foreground">{value ?? '—'}</p>
        {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      {Icon && (
        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', TONES[tone])}>
          <Icon className="size-4.5" aria-hidden="true" />
        </div>
      )}
    </motion.div>
  )
  return to ? (
    <Link to={to} className="block focus-visible:rounded-xl" aria-label={`${label}: ${value}`}>
      {body}
    </Link>
  ) : (
    body
  )
}

export function KpiGrid({ children, className }) {
  return <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5', className)}>{children}</div>
}
