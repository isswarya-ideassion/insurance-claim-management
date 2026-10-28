import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { policiesService } from '@/services/claimsService.js'
import { useAction } from '@/hooks/useApi.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDate } from '@/utils/format.js'

const TERMS = [
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: '24', label: '24 months' },
]

/** Same rule as the server: the new period starts at the current expiry, or today if already expired. */
export function proposedExpiry(expiryDate, months, today = new Date()) {
  const expiry = new Date(`${String(expiryDate).slice(0, 10)}T00:00:00Z`)
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const next = new Date(expiry > todayUtc ? expiry : todayUtc)
  next.setUTCMonth(next.getUTCMonth() + Number(months))
  return next.toISOString().slice(0, 10)
}

export function RenewPolicyDialog({ policy, open, onOpenChange, onRequested }) {
  const [term, setTerm] = useState('12')
  const [notes, setNotes] = useState('')
  const action = useAction()

  useEffect(() => {
    if (open) {
      setTerm('12')
      setNotes('')
    }
  }, [open])

  if (!policy) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renew policy {policy.external_policy_no}</DialogTitle>
          <DialogDescription>
            We review your request and confirm the renewal and premium with you. Your current cover stays in place until then.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 text-sm sm:grid-cols-2">
            <p>
              <span className="block text-xs text-muted-foreground">Current expiry</span>
              {formatDate(policy.expiry_date)}
            </p>
            <p>
              <span className="block text-xs text-muted-foreground">Renewed until (if approved)</span>
              <strong>{formatDate(proposedExpiry(policy.expiry_date, term))}</strong>
            </p>
          </div>
          <FormField label="Renewal term" required>
            <Select value={term} onValueChange={setTerm} options={TERMS} />
          </FormField>
          <FormField label="Anything we should know?" hint="Optional, for example a change of address or vehicle.">
            <Textarea value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="accent"
            loading={action.pending}
            onClick={async () => {
              const result = await action.run(() => policiesService.requestRenewal(policy.id, { termMonths: Number(term), notes: notes.trim() || null }), {
                success: 'Renewal requested. We will be in touch shortly.',
              })
              if (result) {
                onOpenChange(false)
                onRequested?.(result)
              }
            }}
          >
            <RefreshCw /> Request renewal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
