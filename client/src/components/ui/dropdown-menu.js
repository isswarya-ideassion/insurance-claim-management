import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils.js'

export const DropdownMenu = DropdownPrimitive.Root
export const DropdownMenuTrigger = DropdownPrimitive.Trigger

export function DropdownMenuContent({ className, align = 'end', sideOffset = 6, ...props }) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn('z-50 min-w-48 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg', className)}
        {...props}
      />
    </DropdownPrimitive.Portal>
  )
}

export function DropdownMenuItem({ className, ...props }) {
  return (
    <DropdownPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuLabel({ className, ...props }) {
  return <DropdownPrimitive.Label className={cn('px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground', className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }) {
  return <DropdownPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup

export function DropdownMenuRadioItem({ className, children, ...props }) {
  return (
    <DropdownPrimitive.RadioItem
      className={cn('relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-muted', className)}
      {...props}
    >
      <DropdownPrimitive.ItemIndicator className="absolute left-2 size-2 rounded-full bg-accent" />
      {children}
    </DropdownPrimitive.RadioItem>
  )
}
