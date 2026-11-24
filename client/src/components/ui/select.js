import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils.js'

export function Select({ value, onValueChange, placeholder, options, sections, className, triggerClassName, disabled, id, 'aria-label': ariaLabel, allowClear }) {
  const CLEAR = '__all__'
  return (
    <SelectPrimitive.Root
      value={value || (allowClear ? CLEAR : undefined)}
      onValueChange={(v) => onValueChange(v === CLEAR ? '' : v)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 data-[placeholder]:text-muted-foreground',
          triggerClassName,
        )}
      >
        {/* One line: a long label is truncated rather than wrapping the trigger. */}
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <ChevronDown className="size-4 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className={cn('z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover shadow-lg', className)}>
          
<SelectPrimitive.Viewport className="p-1">
  {allowClear && (
    <SelectItem value={CLEAR}>
      {placeholder || 'All'}
    </SelectItem>
  )}

  {sections ? (
    sections.map((section, index) => (
      <SelectPrimitive.Group key={index}>
        {section.label && (
          <SelectPrimitive.Label className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
            {section.label}
          </SelectPrimitive.Label>
        )}

        {section.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPrimitive.Group>
    ))
  ) : (
    options.map((option) => (
      <SelectItem key={option.value} value={option.value}>
        {option.label}
      </SelectItem>
    ))
  )}
</SelectPrimitive.Viewport>

        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

function SelectItem({ children, ...props }) {
  return (
    <SelectPrimitive.Item
      className="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:opacity-50"
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-2">
        <Check className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}
