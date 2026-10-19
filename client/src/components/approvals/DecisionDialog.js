import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { useAction } from '@/hooks/useApi.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Textarea } from '@/components/ui/input.js'
import { FormField, KeyValue } from '@/components/common/FormField.js'
import { formatMoney } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

const DECISIONS = [
  { value: 'APPROVED', label: 'Approve', active: 'border-emerald-500 bg-emerald-50 text-emerald-800' },
  { value: 'RETURNED', label: 'Return for correction', active: 'border-orange-500 bg-orange-50 text-orange-800' },
  { value: 'REJECTED', label: 'Reject', active: 'border-red-500 bg-red-50 text-red-800' },
]

/**
 * Financial decision dialog for reserves and settlements. The server enforces
 * approval limits and self-approval rules; canApprove/reason only guide the UI.
 */
export function DecisionDialog({ open, onOpenChange, title, item, details = [], onDecide, complianceHold = false }) {
  const [decision, setDecision] = useState('APPROVED')
  const [comments, setComments] = useState('')
  const action = useAction()
  const approveBlocked = item && (item.canApprove === false || complianceHold)

  useEffect(() => {
    if (open) {
      setDecision(approveBlocked ? 'RETURNED' : 'APPROVED')
      setComments('')
    }
  }, [open])

  async function submit() {
    const result = await action.run(() => onDecide({ decision, comments: comments || undefined }), {
      success: decision === 'APPROVED' ? 'Approved' : decision === 'RETURNED' ? 'Returned for correction' : 'Rejected',
    })
    if (result) onOpenChange(false)
  }

  const needsComment = decision !== 'APPROVED'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Decisions are recorded permanently with your approval limit at the time of decision.</DialogDescription>
        </DialogHeader>
        {item && (
          <div className="rounded-lg border bg-muted/40 p-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Requested amount</p>
            <p className="tabular text-2xl font-semibold">{formatMoney(item.amount)}</p>
            {details.length > 0 && <KeyValue className="mt-3" items={details} />}
          </div>
        )}
        {item?.canDecide === false && (
          <p className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {item.reason}
          </p>
        )}
        {item?.canDecide !== false && approveBlocked && (
          <p className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {complianceHold ? 'An active compliance hold blocks approval.' : item.reason}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Decision">
          {DECISIONS.map((d) => {
            const disabled = d.value === 'APPROVED' && approveBlocked
            return (
              <button
                key={d.value}
                type="button"
                role="radio"
                aria-checked={decision === d.value}
                disabled={disabled}
                onClick={() => setDecision(d.value)}
                className={cn('rounded-lg border p-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40', decision === d.value ? d.active : 'hover:bg-muted')}
              >
                {d.label}
              </button>
            )
          })}
        </div>
        <FormField label={needsComment ? 'Comments (required)' : 'Comments'} required={needsComment}>
          <Textarea value={comments} onChange={(e) => setComments(e.target.value)} placeholder={needsComment ? 'Explain what needs to change or why the request is rejected.' : 'Optional note for the record.'} />
        </FormField>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={decision === 'REJECTED' ? 'destructive' : decision === 'APPROVED' ? 'accent' : 'default'}
            onClick={submit}
            loading={action.pending}
            disabled={item?.canDecide === false || (needsComment && comments.trim().length < 5) || (decision === 'APPROVED' && approveBlocked)}
          >
            Confirm decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
