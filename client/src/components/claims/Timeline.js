import { motion } from 'framer-motion'
import { Activity, FileText, Inbox, MessageSquare, StickyNote, Workflow } from 'lucide-react'
import { formatDateTime, formatRelative } from '@/utils/format.js'
import { EmptyState } from '@/components/common/States.js'
import { cn } from '@/lib/utils.js'

const ICONS = {
  STATUS: { icon: Workflow, className: 'bg-teal-100 text-teal-700' },
  DOCUMENT: { icon: FileText, className: 'bg-blue-100 text-blue-700' },
  REQUEST: { icon: Inbox, className: 'bg-amber-100 text-amber-700' },
  CUSTOMER_NOTE: { icon: MessageSquare, className: 'bg-violet-100 text-violet-700' },
  INTERNAL_NOTE: { icon: StickyNote, className: 'bg-slate-200 text-slate-700' },
  AUDIT: { icon: Activity, className: 'bg-slate-100 text-slate-600' },
}

export function Timeline({ events }) {
  if (!events?.length) return <EmptyState icon={Activity} title="No activity yet" />
  return (
    <ol className="relative space-y-5 border-l border-border pl-6" aria-label="Claim timeline">
      {events.map((e, i) => {
        const meta = ICONS[e.type] || ICONS.AUDIT
        const Icon = meta.icon
        return (
          <motion.li key={e.id} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 12) * 0.02 }} className="relative">
            <span className={cn('absolute -left-[37px] flex size-7 items-center justify-center rounded-full ring-4 ring-card', meta.className)}>
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-medium">{e.title}</p>
              <time className="tabular text-xs text-muted-foreground" dateTime={e.at}>
                {formatDateTime(e.at)} <span className="text-muted-foreground/70">· {formatRelative(e.at)}</span>
              </time>
            </div>
            {e.description && <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">{e.description}</p>}
            {e.actorName && <p className="mt-0.5 text-xs text-muted-foreground">by {e.actorName}</p>}
          </motion.li>
        )
      })}
    </ol>
  )
}
