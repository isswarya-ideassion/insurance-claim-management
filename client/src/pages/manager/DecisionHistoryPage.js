import { Link } from 'react-router-dom'
import { History } from 'lucide-react'
import { approvalsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Select } from '@/components/ui/select.js'
import { Switch } from '@/components/ui/misc.js'
import { formatDateTime, formatMoney, humanize } from '@/utils/format.js'

export default function DecisionHistoryPage() {
  const { can } = useAuth()
  const { params, setParams } = useListParams()
  const query = useApiQuery(() => approvalsService.history(params), [JSON.stringify(params)])
  return (
    <MotionPage>
      <PageHeader title="Approval decision history" description="Immutable record of every reserve and settlement decision." />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-44"><Select aria-label="Type" allowClear placeholder="All types" value={params.type || ''} onValueChange={(type) => setParams({ type })} options={[{ value: 'RESERVE', label: 'Reserve' }, { value: 'SETTLEMENT', label: 'Settlement' }]} /></div>
          <div className="w-44"><Select aria-label="Decision" allowClear placeholder="All decisions" value={params.decision || ''} onValueChange={(decision) => setParams({ decision })} options={['APPROVED', 'RETURNED', 'REJECTED'].map((d) => ({ value: d, label: humanize(d) }))} /></div>
          {can('reserves.decide') && (
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={params.mine === 'true'} onCheckedChange={(v) => setParams({ mine: v ? 'true' : '' })} aria-label="My decisions" />
              My decisions
            </label>
          )}
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={<EmptyState icon={History} title="No decisions found" />}
          columns={[
            { key: 'decided_at', header: 'Decided', cell: (a) => formatDateTime(a.decided_at) },
            { key: 'claim_number', header: 'Claim', cell: (a) => <Link to={`/claims/${a.claim_id}?tab=approvals`} className="text-primary hover:underline">{a.claim_number}</Link> },
            { key: 'approval_type', header: 'Type', cell: (a) => humanize(a.approval_type) },
            { key: 'decision', header: 'Decision', cell: (a) => <StatusBadge value={a.decision} /> },
            { key: 'amount', header: 'Amount', className: 'tabular', cell: (a) => formatMoney(a.amount) },
            { key: 'decided_by_name', header: 'Decided by' },
            { key: 'approver_limit', header: 'Limit', className: 'tabular', cell: (a) => formatMoney(a.approver_limit) },
            { key: 'requested_by_name', header: 'Requested by' },
            { key: 'comments', header: 'Comments', cell: (a) => <span className="line-clamp-2 max-w-xs">{a.comments || '—'}</span> },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
    </MotionPage>
  )
}
