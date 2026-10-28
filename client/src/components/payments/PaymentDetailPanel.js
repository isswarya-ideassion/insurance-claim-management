import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, FlaskConical, Landmark, Pencil, PlayCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge, ClaimStatusBadge } from '@/components/common/StatusBadge.js'
import { KeyValue, SectionCard, FormField } from '@/components/common/FormField.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { DataTable } from '@/components/common/DataTable.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime, formatMoney } from '@/utils/format.js'

const newKey = () => `pay-${crypto.randomUUID()}`

export function SimulatedNotice() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong>Simulated payment adapter.</strong> No money is moved and no bank is contacted. References beginning with “SIM-” are generated locally for demonstration only.
      </p>
    </div>
  )
}

export function PaymentDetailPanel({ paymentId, onChanged }) {
  const { can } = useAuth()
  const query = useApiQuery(() => paymentsService.get(paymentId), [paymentId])
  const action = useAction()
  const attemptKey = useRef(newKey())
  const [confirmProcess, setConfirmProcess] = useState(false)
  const [beneficiaryOpen, setBeneficiaryOpen] = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [revealed, setRevealed] = useState(null)
  const [benForm, setBenForm] = useState({})
  const [reconRef, setReconRef] = useState('')

  const refresh = async () => {
    await query.reload()
    onChanged?.()
  }

  async function processPayment() {
    const res = await action.run(() => paymentsService.process(paymentId, attemptKey.current))
    if (!res) return false
    attemptKey.current = newKey()
    const payment = res.data.payment
    if (res.meta?.replayed) toast.info('This attempt was already processed; showing the recorded result.')
    else if (payment.status === 'PAID') toast.success(`Simulated payment completed: ${payment.transaction_reference}`)
    else toast.error(`Simulated payment failed: ${res.data.attempt.failure_reason}`)
    await refresh()
    return true
  }

  return (
    <QueryState query={query}>
      {(d) => {
        const p = d.payment
        const canProcess = can('payments.process')
        return (
          <div className="space-y-5">
            {p.is_simulated && <SimulatedNotice />}
            {d.complianceHold && (
              <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <ShieldAlert className="size-4" /> An active compliance hold blocks payment processing.
              </p>
            )}
            <SectionCard
              title="Payment request"
              actions={
                <>
                  {canProcess && p.status === 'PENDING' && (
                    <Button size="sm" variant="accent" onClick={() => setConfirmProcess(true)} disabled={d.complianceHold || d.claim.status !== 'PAYMENT_PENDING'}>
                      <PlayCircle /> Process payment
                    </Button>
                  )}
                  {canProcess && p.status === 'FAILED' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => { setBenForm({ beneficiaryName: p.beneficiary_name, beneficiaryBank: p.beneficiary_bank || '', beneficiaryAccount: '', reason: '' }); setBeneficiaryOpen(true) }}>
                        <Pencil /> Update beneficiary
                      </Button>
                      <Button size="sm" variant="accent" loading={action.pending} onClick={() => action.run(async () => { await paymentsService.retry(paymentId, 'Retry requested by payment operations'); await refresh() }, { success: 'Payment queued for retry' })}>
                        <RefreshCw /> Queue retry
                      </Button>
                    </>
                  )}
                  {can('payments.reconcile') && p.status === 'PAID' && (
                    <Button size="sm" variant="outline" onClick={() => { setReconRef(''); setReconcileOpen(true) }}>
                      <Landmark /> Reconcile
                    </Button>
                  )}
                </>
              }
            >
              <KeyValue
                columns={3}
                items={[
                  { label: 'Amount', value: <span className="tabular text-lg font-semibold">{formatMoney(p.amount)}</span> },
                  { label: 'Status', value: <StatusBadge value={p.status} /> },
                  { label: 'Claim', value: <Link className="text-primary hover:underline" to={`/claims/${d.claim.id}`}>{d.claim.claim_number}</Link> },
                  { label: 'Claim status', value: <ClaimStatusBadge status={d.claim.status} /> },
                  { label: 'Claimant', value: d.claim.customer_name },
                  { label: 'Provider', value: `${p.provider}${p.is_simulated ? ' (simulated)' : ''}` },
                  { label: 'Transaction reference', value: p.transaction_reference || '—' },
                  { label: 'Paid at', value: formatDateTime(p.paid_at) },
                  { label: 'Attempts', value: p.attempt_count },
                  p.last_failure_reason && { label: 'Last failure', value: <span className="text-red-700">{p.last_failure_reason}</span>, wide: true },
                  p.reconciled_at && { label: 'Reconciled', value: `${formatDateTime(p.reconciled_at)} by ${p.reconciled_by_name} (${p.reconciliation_reference})`, wide: true },
                ]}
              />
            </SectionCard>

            <SectionCard
              title="Beneficiary"
              description="Account numbers are masked. Full details are shown only to payment operations and every reveal is audited."
              actions={
                d.canViewBeneficiary && !revealed && (
                  <Button size="sm" variant="outline" onClick={() => action.run(async () => setRevealed(await paymentsService.beneficiary(paymentId)))}>
                    <Eye /> Reveal details
                  </Button>
                )
              }
            >
              <KeyValue
                columns={3}
                items={[
                  { label: 'Name', value: revealed?.beneficiaryName || p.beneficiary_name },
                  { label: 'Bank', value: revealed?.beneficiaryBank || p.beneficiary_bank },
                  { label: 'Account', value: <span className="font-mono">{revealed?.beneficiaryAccount || p.beneficiary_account_masked}</span> },
                ]}
              />
            </SectionCard>

            <SectionCard title="Settlement approval">
              <KeyValue
                columns={3}
                items={[
                  { label: 'Approved amount', value: formatMoney(d.settlement?.amount) },
                  { label: 'Approved by', value: d.approval?.decided_by_name },
                  { label: 'Decided', value: formatDateTime(d.approval?.decided_at) },
                ]}
              />
            </SectionCard>

            <SectionCard title="Payment attempts" bodyClassName="p-0">
              <DataTable
                rows={d.attempts}
                columns={[
                  { key: 'attempt_no', header: '#' },
                  { key: 'status', header: 'Result', cell: (a) => <StatusBadge value={a.status} /> },
                  { key: 'provider_reference', header: 'Reference', cell: (a) => a.provider_reference || '—' },
                  { key: 'failure_reason', header: 'Failure reason', cell: (a) => (a.failure_reason ? <span className="text-red-700">{a.failure_reason}</span> : '—') },
                  { key: 'initiated_by_name', header: 'Initiated by' },
                  { key: 'started_at', header: 'Started', cell: (a) => formatDateTime(a.started_at) },
                ]}
                empty={<p className="p-4 text-sm text-muted-foreground">No attempts yet.</p>}
              />
            </SectionCard>

            <ConfirmDialog
              open={confirmProcess}
              onOpenChange={setConfirmProcess}
              title="Process payment?"
              description={`Send ${formatMoney(p.amount)} to ${p.beneficiary_name} (${p.beneficiary_account_masked}) through the ${p.provider.toLowerCase()} adapter. Repeated clicks reuse the same idempotency key, so the payment is processed at most once.`}
              confirmLabel="Process payment"
              onConfirm={processPayment}
            />

            <Dialog open={beneficiaryOpen} onOpenChange={setBeneficiaryOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Update beneficiary details</DialogTitle>
                  <DialogDescription>Changes are audited. Confirm new details directly with the claimant before saving.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <FormField label="Beneficiary name" required>
                    <Input value={benForm.beneficiaryName || ''} onChange={(e) => setBenForm((f) => ({ ...f, beneficiaryName: e.target.value }))} />
                  </FormField>
                  <FormField label="Bank">
                    <Input value={benForm.beneficiaryBank || ''} onChange={(e) => setBenForm((f) => ({ ...f, beneficiaryBank: e.target.value }))} />
                  </FormField>
                  <FormField label="Account number" required hint="6–20 digits">
                    <Input inputMode="numeric" value={benForm.beneficiaryAccount || ''} onChange={(e) => setBenForm((f) => ({ ...f, beneficiaryAccount: e.target.value.replace(/\D/g, '') }))} />
                  </FormField>
                  <FormField label="Reason for change" required>
                    <Textarea value={benForm.reason || ''} onChange={(e) => setBenForm((f) => ({ ...f, reason: e.target.value }))} />
                  </FormField>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setBeneficiaryOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    loading={action.pending}
                    disabled={!benForm.beneficiaryName || (benForm.beneficiaryAccount || '').length < 6 || (benForm.reason || '').trim().length < 5}
                    onClick={async () => {
                      const ok = await action.run(() => paymentsService.updateBeneficiary(paymentId, { ...benForm, beneficiaryBank: benForm.beneficiaryBank || null }), { success: 'Beneficiary updated' })
                      if (ok) {
                        setBeneficiaryOpen(false)
                        setRevealed(null)
                        refresh()
                      }
                    }}
                  >
                    Save details
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={reconcileOpen} onOpenChange={setReconcileOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Reconcile payment</DialogTitle>
                  <DialogDescription>Record the statement reference that confirms this payment.</DialogDescription>
                </DialogHeader>
                <FormField label="Reconciliation reference" required>
                  <Input value={reconRef} onChange={(e) => setReconRef(e.target.value)} placeholder="e.g. BANK-STMT-2026-10-19" />
                </FormField>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setReconcileOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    loading={action.pending}
                    disabled={reconRef.trim().length < 3}
                    onClick={async () => {
                      const ok = await action.run(() => paymentsService.reconcile(paymentId, { reconciliationReference: reconRef }), { success: 'Payment reconciled' })
                      if (ok) {
                        setReconcileOpen(false)
                        refresh()
                      }
                    }}
                  >
                    Mark reconciled
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )
      }}
    </QueryState>
  )
}
