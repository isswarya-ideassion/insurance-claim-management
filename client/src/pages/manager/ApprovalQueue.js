import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, Gavel, ShieldAlert } from 'lucide-react'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { PriorityBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { Tooltip } from '@/components/ui/misc.js'
import { DecisionDialog } from '@/components/approvals/DecisionDialog.js'
import { formatMoney, formatRelative, humanize } from '@/utils/format.js'

/** Shared queue for reserve and settlement approvals (separate records and endpoints). */
export function ApprovalQueue({ kind, title, description, load, decide }) {
  const { user, can } = useAuth()
  const { params, setParams } = useListParams()
  const query = useApiQuery(() => load(params), [params.page, params.pageSize])
  const [deciding, setDeciding] = useState(null)
  const canDecide = can(kind === 'reserve' ? 'reserves.decide' : 'settlements.decide')

  const columns = [
    {
      key: 'claim_number',
      header: 'Claim',
      cell: (r) => (
        <div>
          <Link to={`/claims/${r.claim_id}?tab=${kind === 'reserve' ? 'reserves' : 'approvals'}`} className="font-medium text-primary hover:underline">{r.claim_number}</Link>
          <div className="text-xs text-muted-foreground">{r.customer_name} · {humanize(r.claim_type)}</div>
        </div>
      ),
    },
    { key: 'amount', header: 'Requested', className: 'tabular font-semibold', cell: (r) => formatMoney(r.amount) },
    { key: 'claimed_amount', header: 'Claimed', className: 'tabular text-muted-foreground', cell: (r) => formatMoney(r.claimed_amount) },
    kind === 'settlement' && { key: 'approved_reserve', header: 'Approved reserve', className: 'tabular', cell: (r) => formatMoney(r.approved_reserve) },
    kind === 'reserve' && { key: 'assessment', header: 'Recommendation', cell: (r) => (r.assessment ? `${humanize(r.assessment.recommendation)} · ${formatMoney(r.assessment.recommended_settlement)}` : '—') },
    { key: 'claim_priority', header: 'Priority', cell: (r) => <PriorityBadge value={r.claim_priority} /> },
    { key: 'requested_by_name', header: 'Requested by' },
    { key: 'requested_at', header: 'Waiting', cell: (r) => formatRelative(r.requested_at) },
    {
      key: 'authority',
      header: 'Your authority',
      cell: (r) =>
        r.compliance_hold ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700"><ShieldAlert className="size-3.5" /> Compliance hold</span>
        ) : r.canApprove ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="size-3.5" /> Within limit</span>
        ) : (
          <Tooltip content={r.reason}><span className="text-xs text-amber-700">{r.canDecide === false ? 'Cannot decide' : 'Above limit'}</span></Tooltip>
        ),
    },
    canDecide && {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (r) => (
        <Button size="sm" variant="accent" disabled={r.canDecide === false} onClick={() => setDeciding(r)}>
          <Gavel /> Decide
        </Button>
      ),
    },
  ].filter(Boolean)

  return (
    <MotionPage>
      <PageHeader title={title} description={`${description} Your approval limit: ${user.approvalLimit != null ? formatMoney(user.approvalLimit) : 'none'}.`} />
      <div className="rounded-xl border bg-card shadow-sm">
        <DataTable rows={query.data} columns={columns} loading={query.loading} error={query.error} onRetry={query.reload} empty={<EmptyState icon={Gavel} title="No pending approvals" description="Requests awaiting a decision will appear here." />} />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <DecisionDialog
        open={Boolean(deciding)}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={`${kind === 'reserve' ? 'Reserve' : 'Settlement'} decision — ${deciding?.claim_number || ''}`}
        item={deciding}
        complianceHold={deciding?.compliance_hold}
        details={
          deciding
            ? [
                { label: 'Claimant', value: deciding.customer_name },
                { label: 'Requested by', value: deciding.requested_by_name },
                kind === 'reserve' && deciding.assessment && { label: 'Findings', value: deciding.assessment.findings, wide: true },
                kind === 'settlement' && { label: 'Beneficiary', value: `${deciding.beneficiary_name} · ${deciding.beneficiary_account_masked}` },
              ]
            : []
        }
        onDecide={async (body) => {
          const result = await decide(deciding.id, body)
          await query.reload()
          return result
        }}
      />
    </MotionPage>
  )
}
