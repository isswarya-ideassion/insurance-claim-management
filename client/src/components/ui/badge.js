import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils.js'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-slate-200 bg-slate-100 text-slate-700',
        navy: 'border-blue-200 bg-blue-50 text-blue-800',
        teal: 'border-teal-200 bg-teal-50 text-teal-800',
        green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        amber: 'border-amber-200 bg-amber-50 text-amber-800',
        orange: 'border-orange-200 bg-orange-50 text-orange-800',
        red: 'border-red-200 bg-red-50 text-red-700',
        violet: 'border-violet-200 bg-violet-50 text-violet-800',
        solid: 'border-transparent bg-primary text-primary-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Badge({ className, tone, dot = false, children, ...props }) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />}
      {children}
    </span>
  )
}
