import { forwardRef } from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '@/lib/utils.js'

const fieldBase =
  'flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive'

const PICKER_TYPES = ['date', 'datetime-local', 'time', 'month']

export const Input = forwardRef(function Input({ className, type = 'text', onClick, ...props }, ref) {
  const picker = PICKER_TYPES.includes(type)
  return (
    <input
      type={type}
      ref={ref}
      className={cn(fieldBase, 'h-9', picker && 'cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer', className)}
      onClick={(e) => {
        // Browsers only open the calendar from the small icon; open it from anywhere in the field.
        // showPicker throws if the field is read-only/disabled or the browser refuses it, so it is best-effort.
        if (picker && !props.disabled && !props.readOnly) {
          try {
            e.currentTarget.showPicker?.()
          } catch {
            /* typing the date still works */
          }
        }
        onClick?.(e)
      }}
      {...props}
    />
  )
})

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-[88px] resize-y', className)} {...props} />
})

export const NativeSelect = forwardRef(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-9 pr-8', className)} {...props}>
      {children}
    </select>
  )
})

export const Label = forwardRef(function Label({ className, ...props }, ref) {
  return <LabelPrimitive.Root ref={ref} className={cn('text-sm font-medium leading-none text-foreground', className)} {...props} />
})
