import { CheckCircle2, Circle } from 'lucide-react'
import { cn } from '@/lib/utils.js'

/** The tick / empty circle beside a step in a progress list or stepper. */
export function StepMark({ done, className }) {
  return done ? (
    <CheckCircle2 className={cn('size-3.5 shrink-0 text-accent', className)} aria-label="Done" />
  ) : (
    <Circle className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-label="Not done" />
  )
}
