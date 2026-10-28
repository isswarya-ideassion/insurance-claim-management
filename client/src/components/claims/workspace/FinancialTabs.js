import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Gavel, PencilLine, Scale } from 'lucide-react'
import { RESERVE_REASON_CODES, ROLE_LABELS } from '@shared/constants.js'
import { approvalsService, paymentsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField, SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { DecisionDialog } from '@/components/approvals/DecisionDialog.js'
import { SimulatedNotice } from '@/components/payments/PaymentDetailPanel.js'
import { formatDateTime, formatMoney, humanize } from '@/utils/format.js'
import { PayeeAgentCard, ReserveAgentCard } from '@/components/automation/AgentPanels.js'

// System-recorded ledger entries (manager modifications, payments, closure releases) cannot be entered by hand.
const MANUAL_REASON_CODES = RESERVE_REASON_CODES.filter((c) => !['MANAGER_MODIFIED', 'PAYMENT_ISSUED', 'CLOSURE_RELEASE'].includes(c))
const REVISABLE_STATUSES = ['INVESTIGATION', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID', 'REOPENED']

function ReviseReserveDialog({ open, onOpenChange, claimId, onSaved }) {
  const [form, setForm] = useState({ amount: '', reasonCode: 'REVISED_ESTIMATE', notes: '' })
  const action = useAction()
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }))
  async function submit() {
    const result = await action.run(() => approvalsService.reviseReserve(claimId, { amount: Number(form.amount), reasonCode: form.reasonCode, notes: form.notes || undefined }))
    if (result) {
      onOpenChange(false)
      onSaved?.(result)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revise reserve</DialogTitle>
          <DialogDescription>Each revision is a new ledger entry. Within your reserve authority it posts immediately; above it, a Claims Manager reviews it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="New reserve amount (₹)" required>
            <Input type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} />
          </FormField>
          <FormField label="Reason" required>
            <Select value={form.reasonCode} onValueChange={set('reasonCode')} options={MANUAL_REASON_CODES.map((c) => ({ value: c, label: humanize(c) }))} />
          </FormField>
          <FormField label="Notes">
            <Textarea value={form.notes} onChange={set('notes')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={action.pending} disabled={form.amount === '' || Number(form.amount) < 0}>
            Save revision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ReservesTab({ detail, reload }) {
  const { claim } = detail
  const { can, user } = useAuth()
  const query = useApiQuery(() => approvalsService.claimReserves(claim.id), [claim.id, claim.status])
  const [deciding, setDeciding] = useState(null)
  const [revising, setRevising] = useState(false)
  const canRevise = can('reserves.set') && claim.assigned_adjuster_id === user.id && REVISABLE_STATUSES.includes(claim.status)
  const refresh = async () => {
    await query.reload()
    reload()
  }
  return (
    <div className="space-y-5">
    <SectionCard
      title="Reserve ledger"
      description="Every reserve change is an immutable entry. Entries within the adjuster's authority post directly; larger ones need Claims Manager review."
      bodyClassName="p-0"
      actions={
        canRevise && (
          <Button size="sm" variant="outline" onClick={() => setRevising(true)}>
            <PencilLine /> Revise reserve
          </Button>
        )
      }
    >
      <QueryState query={query}>
        {(rows) => (
          <DataTable
            rows={rows}
            empty={<p className="p-4 text-sm text-muted-foreground">No reserve entries yet.</p>}
            columns={[
              { key: 'amount', header: 'Amount', className: 'tabular font-medium', cell: (r) => formatMoney(r.amount) },
              { key: 'approval_status', header: 'Status', cell: (r) => <StatusBadge value={r.approval_status} /> },
              { key: 'reason_code', header: 'Reason', cell: (r) => humanize(r.reason_code) },
              { key: 'coverage_line', header: 'Coverage line', cell: (r) => humanize(r.coverage_line) || '—' },
              { key: 'notes', header: 'Notes', cell: (r) => r.notes || '—' },
              { key: 'set_by_name', header: 'Set by', cell: (r) => r.set_by_name || 'System' },
              { key: 'effective_at', header: 'Effective', cell: (r) => formatDateTime(r.effective_at) },
              { key: 'approved_by_name', header: 'Reviewed by', cell: (r) => (r.approved_by_name ? `${r.approved_by_name} · ${formatDateTime(r.approved_at)}` : '—') },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                cell: (r) =>
                  r.approval_status === 'PENDING_REVIEW' && can('reserves.review') && claim.status === 'RESERVE_APPROVAL' ? (
                    <Button size="sm" variant="accent" onClick={() => setDeciding(r)}>
                      <Scale /> Review
                    </Button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryState>
      <DecisionDialog
        open={Boolean(deciding)}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={`Reserve review — ${claim.claim_number}`}
        item={deciding}
        allowModify
        details={deciding ? [{ label: 'Set by', value: deciding.set_by_name }, { label: 'Claimed amount', value: formatMoney(claim.estimated_loss) }] : []}
        onDecide={async (body) => {
          const result = await approvalsService.reviewReserve(deciding.id, body)
          await refresh()
          return result
        }}
      />
      <ReviseReserveDialog open={revising} onOpenChange={setRevising} claimId={claim.id} onSaved={refresh} />
    </SectionCard>
    <ReserveAgentCard claim={claim} onApplied={refresh} />
    </div>
  )
}

export function StepsSummary({ steps = [] }) {
  if (!steps.length) return '—'
  return (
    <ol className="space-y-0.5 text-xs">
      {steps.map((s) => (
        <li key={s.id}>
          {s.step_no}. {ROLE_LABELS[s.required_role]} · <span className="font-medium">{humanize(s.status)}</span>
          {s.approver_name && ` by ${s.approver_name}`}
        </li>
      ))}
    </ol>
  )
}

export function ApprovalsTab({ detail, reload }) {
  const { claim, complianceHold } = detail
  const { can } = useAuth()
  const settlements = useApiQuery(() => approvalsService.claimSettlements(claim.id), [claim.id, claim.status])
  const decisions = useApiQuery(() => approvalsService.claimApprovals(claim.id), [claim.id, claim.status])
  const [deciding, setDeciding] = useState(null)
  return (
    <div className="space-y-5">
      <SectionCard title="Settlement approvals" description="Created when compliance clears the claim. The assigned adjuster approves it within their settlement authority; larger amounts go to a Claims Manager." bodyClassName="p-0">
        <QueryState query={settlements}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No settlements yet.</p>}
              columns={[
                { key: 'amount', header: 'Amount', className: 'tabular font-medium', cell: (s) => formatMoney(s.amount) },
                { key: 'status', header: 'Status', cell: (s) => <StatusBadge value={s.status} /> },
                { key: 'payee_name', header: 'Payee', cell: (s) => `${s.payee_name || '—'} (${s.payee_account_masked || 'no account'})` },
                { key: 'steps', header: 'Approval steps', cell: (s) => <StepsSummary steps={s.steps} /> },
                { key: 'requested_by_name', header: 'Prepared by' },
                { key: 'requested_at', header: 'Requested', cell: (s) => formatDateTime(s.requested_at) },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (s) =>
                    s.status === 'PENDING_APPROVAL' && can('settlements.approve') && s.canDecide && claim.status === 'SETTLEMENT_APPROVAL' ? (
                      <Button size="sm" variant="accent" onClick={() => setDeciding(s)}>
                        <Gavel /> Decide
                      </Button>
                    ) : null,
                },
              ]}
            />
          )}
        </QueryState>
      </SectionCard>
      <SectionCard title="Decision history" description="Reserve, evaluation, closure and settlement decisions. Every decision is an immutable record." bodyClassName="p-0">
        <QueryState query={decisions}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No decisions recorded.</p>}
              columns={[
                { key: 'approval_type', header: 'Type', cell: (a) => humanize(a.approval_type) },
                { key: 'decision', header: 'Decision', cell: (a) => <StatusBadge value={a.decision} /> },
                { key: 'amount', header: 'Amount', className: 'tabular', cell: (a) => formatMoney(a.amount) },
                { key: 'decided_by_name', header: 'Decided by' },
                { key: 'approver_limit', header: 'Limit at decision', className: 'tabular', cell: (a) => formatMoney(a.approver_limit) },
                { key: 'requested_by_name', header: 'Requested by' },
                { key: 'comments', header: 'Comments', cell: (a) => a.comments || '—' },
                { key: 'decided_at', header: 'Decided', cell: (a) => formatDateTime(a.decided_at) },
              ]}
            />
          )}
        </QueryState>
      </SectionCard>
      <DecisionDialog
        open={Boolean(deciding)}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={`Settlement approval — ${claim.claim_number}`}
        item={deciding}
        complianceHold={complianceHold}
        details={deciding ? [{ label: 'Payee', value: deciding.payee_name }, { label: 'Account', value: deciding.payee_account_masked }, { label: 'Payee verification', value: humanize(deciding.payee_verification) }] : []}
        onDecide={async (body) => {
          const result = await approvalsService.decideSettlement(deciding.id, body)
          await Promise.all([settlements.reload(), decisions.reload()])
          reload()
          return result
        }}
      />
      <PayeeAgentCard claim={claim} onApplied={reload} />
    </div>
  )
}

export function PaymentsTab({ detail }) {
  const { claim } = detail
  const query = useApiQuery(() => paymentsService.forClaim(claim.id), [claim.id, claim.status])
  return (
    <div className="space-y-4">
      <SimulatedNotice />
      <QueryState query={query} empty={<p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No payments yet. A payment is created when compliance clears the claim and can be issued once its settlement approval completes.</p>}>
        {(rows) =>
          rows.map((p) => (
            <SectionCard
              key={p.id}
              title={`Payment ${formatMoney(p.amount)}`}
              description={`${p.payee_name} · ${p.payee_account_masked}`}
              actions={
                <>
                  <StatusBadge value={p.status} />
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`/payments/${p.id}`}>Open payment</Link>
                  </Button>
                </>
              }
              bodyClassName="p-0"
            >
              <DataTable
                rows={p.attempts}
                empty={<p className="p-4 text-sm text-muted-foreground">No attempts yet.</p>}
                columns={[
                  { key: 'attempt_no', header: '#' },
                  { key: 'status', header: 'Result', cell: (a) => <StatusBadge value={a.status} /> },
                  { key: 'provider_reference', header: 'Reference', cell: (a) => a.provider_reference || '—' },
                  { key: 'failure_reason', header: 'Failure', cell: (a) => a.failure_reason || '—' },
                  { key: 'initiated_by_name', header: 'By' },
                  { key: 'started_at', header: 'When', cell: (a) => formatDateTime(a.started_at) },
                ]}
              />
            </SectionCard>
          ))
        }
      </QueryState>
    </div>
  )
}
