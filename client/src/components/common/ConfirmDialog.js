import { useEffect, useId, useState } from 'react'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Label, Textarea } from '@/components/ui/input.js'

/**
 * Confirmation for critical actions. With requireReason the user must enter
 * text (minimum reasonMinLength) which is passed to onConfirm(reason).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  variant = 'default',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder,
  reasonMinLength = 5,
  onConfirm,
  children,
}) {
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const id = useId()

  useEffect(() => {
    if (open) setReason('')
  }, [open])

  const invalid = requireReason && reason.trim().length < reasonMinLength

  async function handleConfirm() {
    setPending(true)
    try {
      const ok = await onConfirm(reason.trim())
      if (ok !== false) onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <AlertDialogContent>
        <div className="space-y-1.5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </div>
        {children}
        {requireReason && (
          <div className="space-y-1.5">
            <Label htmlFor={id}>{reasonLabel}</Label>
            <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder} autoFocus />
            <p className="text-xs text-muted-foreground">Minimum {reasonMinLength} characters. Recorded in the audit history.</p>
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant={variant} onClick={handleConfirm} disabled={invalid} loading={pending}>
            {confirmLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
