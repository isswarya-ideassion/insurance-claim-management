import { forwardRef } from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils.js'
import { initials } from '@/utils/format.js'

export const Checkbox = forwardRef(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input bg-card shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-white',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check className="size-3" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
})

export const Switch = forwardRef(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent bg-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
})

export function Separator({ className, orientation = 'horizontal', ...props }) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...props}
    />
  )
}

export function Avatar({ name, className }) {
  return (
    <AvatarPrimitive.Root className={cn('inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-teal-100 text-xs font-semibold text-teal-800', className)}>
      <AvatarPrimitive.Fallback>{initials(name) || '?'}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

export function Progress({ value = 0, className, label }) {
  return (
    <ProgressPrimitive.Root value={value} aria-label={label} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <ProgressPrimitive.Indicator className="h-full bg-accent transition-transform" style={{ transform: `translateX(-${100 - value}%)` }} />
    </ProgressPrimitive.Root>
  )
}

export function Skeleton({ className, ...props }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/80', className)} {...props} />
}

export const TooltipProvider = TooltipPrimitive.Provider

export function Tooltip({ content, children, side = 'top' }) {
  if (!content) return children
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-md">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
