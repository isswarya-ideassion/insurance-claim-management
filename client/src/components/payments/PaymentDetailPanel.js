import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BadgeCheck, Eye, FlaskConical, Landmark, Pencil, PlayCircle, RefreshCw, ShieldAlert } from 'lucide-react'
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
import { StepsSummary } from '@/components/claims/workspace/FinancialTabs.js'
import { formatDateTime, formatMoney, humanize } from '@/utils/format.js'

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
  const { can, user } = useAuth()
  const query = useApiQuery(() => paymentsService.get(paymentId), [paymentId])
  const action = useAction()
  const attemptKey = useRef(newKey())
  const [confirmProcess, setConfirmProcess] = useState(false)
  const [beneficiaryOpen, setBeneficiaryOpen] = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [revealed, setRevealed] = useState(null)
  const [benForm, setBenForm] = useState({})
  const [reconRef, setReconRef] = useState('')
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolution, setResolution] = useState('')

  const refresh = async () => {
    await query.reload()
    onChanged?.()
  }

  async function issuePayment() {
    const res = await action.run(() => paymentsService.issue(paymentId, attemptKey.current))
    if (!res) return false
    attemptKey.current = newKey()
    const payment = res.data.payment
    if (res.meta?.replayed) toast.info('This attempt was already processed; showing the recorded result.')
    else if (payment.status === 'PAID') toast.success(`Simulated payment completed: ${payment.portal_reference}`)
    else toast.error(`Simulated payment failed: ${res.data.attempt.failure_reason}`)
    await refresh()
    return true
  }

  return (
    <QueryState query={query}>
      {(d) => {
        const p = d.payment
        const canIssue = d.canIssue
        const openBlocks = d.blocks.filter((b) => !b.resolved_at)
        const payee = d.payee
        return (
          <div className="space-y-5">
            {p.is_simulated && <SimulatedNotice />}
            {d.complianceHold && (
              <p className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <ShieldAlert className="size-4" /> An active compliance hold blocks payment.
              </p>
            )}
            {can('payments.issue') && !canIssue && p.status === 'PENDING' && (
              <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <ShieldAlert className="size-4" /> You approved this settlement, so another Payment Operator must issue it (separation of duties).
              </p>
            )}
            <SectionCard
              title="Payment request"
              actions={
                <>
                  {canIssue && p.status === 'PENDING' && (
                    <Button size="sm" variant="accent" onClick={() => setConfirmProcess(true)} disabled={d.complianceHold || openBlocks.length > 0 || d.claim.status !== 'PAYMENT_PENDING'}>
                      <PlayCircle /> Issue payment
                    </Button>
                  )}
                  {can('payees.manage') && ['FAILED', 'PENDING', 'PENDING_APPROVAL'].includes(p.status) && (
                    <Button size="sm" variant="outline" onClick={() => { setBenForm({ beneficiaryName: p.payee_name, beneficiaryBank: p.payee_bank || '', beneficiaryAccount: '', reason: '' }); setBeneficiaryOpen(true) }}>
                      <Pencil /> Update payee
                    </Button>
                  )}
                  {can('payments.issue') && p.status === 'FAILED' && (
                    <Button size="sm" variant="accent" onClick={() => { setResolution(''); setResolveOpen(true) }}>
                      <RefreshCw /> Resolve & requeue
                    </Button>
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
                  { label: 'Payment method', value: humanize(p.method) || '—' },
                  { label: 'Portal reference', value: p.portal_reference || '—' },
                  { label: 'Issued at', value: formatDateTime(p.issued_at) },
                  { label: 'Attempts', value: p.attempt_count },
                  p.last_failure_reason && { label: 'Last failure', value: <span className="text-red-700">{p.last_failure_reason}</span>, wide: true },
                  p.cleared_at && { label: 'Reconciled', value: `${formatDateTime(p.cleared_at)} by ${p.reconciled_by_name} (${p.reconciliation_reference})`, wide: true },
                ]}
              />
            </SectionCard>

            {openBlocks.length > 0 && (
              <SectionCard title="Open payment blocks" description="A payment cannot be issued while any block is open.">
                <ul className="space-y-2 text-sm">
                  {openBlocks.map((b) => (
                    <li key={b.id} className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900">
                      <p className="font-medium">{humanize(b.block_type)}</p>
                      {b.detail && <p className="text-xs">{b.detail}</p>}
                      <p className="text-xs text-red-800/80">Opened {formatDateTime(b.opened_at)}{b.opened_by_name ? ` by ${b.opened_by_name}` : ''}</p>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            <SectionCard
              title="Payee"
              description="Bank details are encrypted at rest and masked here. Full details are shown only to Payment Operators and every reveal is audited."
              actions={
                <>
                  {can('payees.manage') && payee && payee.verification_status !== 'VERIFIED' && (
                    <Button
                      size="sm"
                      variant="accent"
                      disabled={payee.bank_details_changed_by === user.id}
                      title={payee.bank_details_changed_by === user.id ? 'Bank details you changed must be verified by another Payment Operator' : undefined}
                      loading={action.pending}
                      onClick={() => action.run(async () => { await paymentsService.verifyPayee(payee.id); await refresh() }, { success: 'Payee verified' })}
                    >
                      <BadgeCheck /> Verify payee
                    </Button>
                  )}
                  {d.canViewBeneficiary && !revealed && (
                    <Button size="sm" variant="outline" onClick={() => action.run(async () => setRevealed(await paymentsService.beneficiary(paymentId)))}>
                      <Eye /> Reveal details
                    </Button>
                  )}
                </>
              }
            >
              <KeyValue
                columns={3}
                items={[
                  { label: 'Name', value: revealed?.beneficiaryName || p.payee_name },
                  { label: 'Bank', value: revealed?.beneficiaryBank || p.payee_bank },
                  { label: 'Account', value: <span className="font-mono">{revealed?.beneficiaryAccount || p.payee_account_masked}</span> },
                  payee && { label: 'Verification', value: <StatusBadge value={payee.verification_status} /> },
                  payee?.verified_at && { label: 'Verified', value: `${formatDateTime(payee.verified_at)} by ${payee.verified_by_name}` },
                  payee?.bank_details_changed_at && { label: 'Details changed', value: `${formatDateTime(payee.bank_details_changed_at)} by ${payee.bank_details_changed_by_name}` },
                  payee?.duplicate_payees?.length > 0 && { label: 'Same account as', value: <span className="text-amber-700">{payee.duplicate_payees.map((x) => x.name).join(', ')}</span>, wide: true },
                ]}
              />
            </SectionCard>

            <SectionCard title="Settlement approval">
              <KeyValue
                columns={3}
                items={[
                  { label: 'Prepared by', value: p.requested_by_name },
                  { label: 'Approved by', value: d.approval?.decided_by_name },
                  { label: 'Decided', value: formatDateTime(d.approval?.decided_at) },
                  { label: 'Approval steps', value: <StepsSummary steps={d.steps} />, wide: true },
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
              title="Issue payment?"
              description={`Send ${formatMoney(p.amount)} to ${p.payee_name} (${p.payee_account_masked}) through the ${p.provider.toLowerCase()} adapter. Repeated clicks reuse the same idempotency key, so the payment is issued at most once.`}
              confirmLabel="Issue payment"
              onConfirm={issuePayment}
            />

            <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Resolve failure & requeue</DialogTitle>
                  <DialogDescription>Record how the failure was resolved. Other blocks (payee verification, bank-detail changes, compliance holds) must be cleared first.</DialogDescription>
                </DialogHeader>
                <FormField label="Resolution" required>
                  <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="e.g. Claimant confirmed the corrected account number by phone." />
                </FormField>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setResolveOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    loading={action.pending}
                    disabled={resolution.trim().length < 5}
                    onClick={async () => {
                      const ok = await action.run(() => paymentsService.resolveBlock(paymentId, resolution), { success: 'Payment queued again' })
                      if (ok) {
                        setResolveOpen(false)
                        refresh()
                      }
                    }}
                  >
                    Requeue payment
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={beneficiaryOpen} onOpenChange={setBeneficiaryOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Update payee bank details</DialogTitle>
                  <DialogDescription>Changes are audited and encrypted. The payee becomes unverified and the payment is blocked until another Payment Operator verifies it.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <FormField label="Payee name" required>
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
                      const ok = await action.run(() => paymentsService.updateBeneficiary(paymentId, { ...benForm, beneficiaryBank: benForm.beneficiaryBank || null }), { success: 'Payee details updated; verification required' })
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
