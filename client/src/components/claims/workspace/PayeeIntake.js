import { useState } from 'react'
import { BadgeCheck, Landmark, Pencil } from 'lucide-react'
import { claimsService } from '@/services/claimsService.js'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField } from '@/components/common/FormField.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime } from '@/utils/format.js'

const EMPTY = { payeeName: '', bankName: '', accountNumber: '', reason: '' }

/**
 * Payee and bank details collected at intake by the Claims Operations Manager.
 * The claim cannot leave intake until someone other than the person who
 * entered the details has verified them.
 */
export function PayeeIntake({ claim, onChanged }) {
  const { can } = useAuth()
  const query = useApiQuery(() => claimsService.payee(claim.id), [claim.id, claim.status])
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: k === 'accountNumber' ? e.target.value.replace(/\D/g, '') : e.target.value }))

  if (!can('payees.intake') && !can('payees.verify')) return null
  const data = query.data
  const payee = data?.payee

  async function refresh() {
    await query.reload()
    onChanged?.()
  }

  return (
    <div>
      <p className="flex items-center gap-2 text-sm font-medium">
        <Landmark className="size-4 text-muted-foreground" aria-hidden="true" /> Payee details
      </p>
      <div className="mt-2 space-y-3 rounded-lg border p-3 text-sm">
        {query.loading && <p className="text-muted-foreground">Loading payee…</p>}
        {query.error && <p className="text-red-700">{query.error.message}</p>}
        {data && !payee?.has_bank_details && <p className="text-muted-foreground">No bank details collected yet. Collect them from the claimant before routing the claim.</p>}
        {payee?.has_bank_details && (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">{payee.name}</p>
              <p className="text-xs text-muted-foreground">
                {payee.bank_name || 'Bank not given'} · <span className="font-mono">{payee.account_masked}</span>
              </p>
              {payee.verification_status === 'VERIFIED' && payee.verified_by_name && (
                <p className="mt-1 text-xs text-muted-foreground">Verified by {payee.verified_by_name} · {formatDateTime(payee.verified_at)}</p>
              )}
              {payee.bank_details_changed_at && (
                <p className="mt-1 text-xs text-muted-foreground">Entered by {payee.bank_details_changed_by_name} · {formatDateTime(payee.bank_details_changed_at)}</p>
              )}
            </div>
            <StatusBadge value={payee.verification_status} />
          </div>
        )}
        {payee?.has_bank_details && payee.verification_status !== 'VERIFIED' && payee.changed_by_me && (
          <p className="text-xs text-amber-800">You entered these details, so another Claims Operations Manager or a Payment Operator must verify them.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {data?.canRecord && (
            <Button size="sm" variant="outline" onClick={() => { setForm({ ...EMPTY, payeeName: payee?.name || '', bankName: payee?.bank_name || '' }); setOpen(true) }}>
              <Pencil /> {payee?.has_bank_details ? 'Update bank details' : 'Collect bank details'}
            </Button>
          )}
          {data?.canVerify && (
            <Button size="sm" variant="accent" loading={action.pending} onClick={() => action.run(async () => { await paymentsService.verifyPayee(payee.id, 'Verified at intake'); await refresh() }, { success: 'Payee verified' })}>
              <BadgeCheck /> Verify payee
            </Button>
          )}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payee bank details</DialogTitle>
            <DialogDescription>The settlement is paid to this account. Details are encrypted, and someone else must verify them before the claim moves on.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Payee name" required className="sm:col-span-2">
              <Input id="payee-name" value={form.payeeName} onChange={set('payeeName')} />
            </FormField>
            <FormField label="Bank">
              <Input id="payee-bank" value={form.bankName} onChange={set('bankName')} />
            </FormField>
            <FormField label="Account number" required hint="6–20 digits">
              <Input id="payee-account" inputMode="numeric" autoComplete="off" value={form.accountNumber} onChange={set('accountNumber')} />
            </FormField>
            <FormField label="Where the details came from" required className="sm:col-span-2">
              <Textarea id="payee-reason" value={form.reason} onChange={set('reason')} placeholder="e.g. Confirmed with the claimant by phone on the number on file" />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              loading={action.pending}
              disabled={form.payeeName.trim().length < 2 || form.accountNumber.length < 6 || form.reason.trim().length < 5}
              onClick={async () => {
                const ok = await action.run(
                  () => claimsService.recordPayee(claim.id, { payeeName: form.payeeName, bankName: form.bankName || null, accountNumber: form.accountNumber, reason: form.reason }),
                  { success: 'Bank details saved; they now need verification' },
                )
                if (ok) {
                  setOpen(false)
                  refresh()
                }
              }}
            >
              Save details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
