import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Gavel, Scale } from 'lucide-react'
import { approvalsService, paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { Button } from '@/components/ui/button.js'
import { DecisionDialog } from '@/components/approvals/DecisionDialog.js'
import { SimulatedNotice } from '@/components/payments/PaymentDetailPanel.js'
import { formatDateTime, formatMoney, humanize } from '@/utils/format.js'

export function ReservesTab({ detail, reload }) {
  const { claim } = detail
  const { can } = useAuth()
  const query = useApiQuery(() => approvalsService.claimReserves(claim.id), [claim.id, claim.status])
  const [deciding, setDeciding] = useState(null)
  return (
    <SectionCard title="Reserve requests" description="Reserves are approved separately from settlements, by a manager within their approval limit." bodyClassName="p-0">
      <QueryState query={query}>
        {(rows) => (
          <DataTable
            rows={rows}
            empty={<p className="p-4 text-sm text-muted-foreground">No reserve requests yet.</p>}
            columns={[
              { key: 'amount', header: 'Amount', className: 'tabular font-medium', cell: (r) => formatMoney(r.amount) },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
              { key: 'reason', header: 'Justification', cell: (r) => r.reason || '—' },
              { key: 'requested_by_name', header: 'Requested by' },
              { key: 'requested_at', header: 'Requested', cell: (r) => formatDateTime(r.requested_at) },
              { key: 'decided_at', header: 'Decided', cell: (r) => formatDateTime(r.decided_at) },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                cell: (r) =>
                  r.status === 'PENDING_APPROVAL' && can('reserves.decide') && claim.status === 'RESERVE_APPROVAL' ? (
                    <Button size="sm" variant="accent" onClick={() => setDeciding(r)}>
                      <Scale /> Decide
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
        title={`Reserve decision — ${claim.claim_number}`}
        item={deciding}
        details={deciding ? [{ label: 'Requested by', value: deciding.requested_by_name }, { label: 'Claimed amount', value: formatMoney(claim.estimated_loss) }] : []}
        onDecide={async (body) => {
          const result = await approvalsService.decideReserve(deciding.id, body)
          await query.reload()
          reload()
          return result
        }}
      />
    </SectionCard>
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
      <SectionCard title="Settlement requests" description="Created when compliance clears the claim. A separate workflow from reserve approval." bodyClassName="p-0">
        <QueryState query={settlements}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No settlement requests yet.</p>}
              columns={[
                { key: 'amount', header: 'Amount', className: 'tabular font-medium', cell: (s) => formatMoney(s.amount) },
                { key: 'status', header: 'Status', cell: (s) => <StatusBadge value={s.status} /> },
                { key: 'beneficiary_name', header: 'Beneficiary', cell: (s) => `${s.beneficiary_name} (${s.beneficiary_account_masked || 'no account'})` },
                { key: 'requested_by_name', header: 'Requested by' },
                { key: 'requested_at', header: 'Requested', cell: (s) => formatDateTime(s.requested_at) },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (s) =>
                    s.status === 'PENDING_APPROVAL' && can('settlements.decide') && claim.status === 'SETTLEMENT_APPROVAL' ? (
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
      <SectionCard title="Decision history" description="Every approval decision is an immutable record." bodyClassName="p-0">
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
        title={`Settlement decision — ${claim.claim_number}`}
        item={deciding}
        complianceHold={complianceHold}
        details={deciding ? [{ label: 'Beneficiary', value: deciding.beneficiary_name }, { label: 'Account', value: deciding.beneficiary_account_masked }] : []}
        onDecide={async (body) => {
          const result = await approvalsService.decideSettlement(deciding.id, body)
          await Promise.all([settlements.reload(), decisions.reload()])
          reload()
          return result
        }}
      />
    </div>
  )
}

export function PaymentsTab({ detail }) {
  const { claim } = detail
  const query = useApiQuery(() => paymentsService.forClaim(claim.id), [claim.id, claim.status])
  return (
    <div className="space-y-4">
      <SimulatedNotice />
      <QueryState query={query} empty={<p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No payment requests. Payments are created when a settlement is approved.</p>}>
        {(rows) =>
          rows.map((p) => (
            <SectionCard
              key={p.id}
              title={`Payment ${formatMoney(p.amount)}`}
              description={`${p.beneficiary_name} · ${p.beneficiary_account_masked}`}
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
