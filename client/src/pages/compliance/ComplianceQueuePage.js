import { Link } from 'react-router-dom'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { complianceService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { ClaimStatusBadge, PriorityBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Select } from '@/components/ui/select.js'
import { formatMoney, formatRelative } from '@/utils/format.js'

export default function ComplianceQueuePage() {
  const { params, setParams } = useListParams({ status: 'PENDING,IN_REVIEW,HOLD,ESCALATED' })
  const query = useApiQuery(() => complianceService.queue(params), [JSON.stringify(params)])
  return (
    <MotionPage>
      <PageHeader title="Compliance review queue" description="Screen claims before settlement. Holds block settlement approval, payment and closure until cleared or excepted." />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-56">
            <Select
              aria-label="Review status"
              value={params.status}
              onValueChange={(status) => setParams({ status })}
              options={[
                { value: 'PENDING,IN_REVIEW,HOLD,ESCALATED', label: 'All open reviews' },
                { value: 'PENDING', label: 'Pending' },
                { value: 'IN_REVIEW', label: 'In review' },
                { value: 'HOLD', label: 'On hold' },
                { value: 'ESCALATED', label: 'Escalated' },
                { value: 'CLEARED,EXCEPTION_APPROVED', label: 'Decided' },
              ]}
            />
          </div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={<EmptyState icon={ShieldCheck} title="No reviews in this view" />}
          columns={[
            {
              key: 'claim_number',
              header: 'Claim',
              cell: (r) => (
                <div>
                  <Link to={`/claims/${r.claim_id}?tab=compliance`} className="font-medium text-primary hover:underline">{r.claim_number}</Link>
                  <div className="text-xs text-muted-foreground">{r.customer_name}</div>
                </div>
              ),
            },
            { key: 'status', header: 'Review', cell: (r) => <div className="flex items-center gap-1.5"><StatusBadge value={r.status} />{r.hold_active && <ShieldAlert className="size-4 text-red-600" aria-label="Hold active" />}</div> },
            { key: 'claim_status', header: 'Claim status', cell: (r) => <ClaimStatusBadge status={r.claim_status} /> },
            { key: 'claim_priority', header: 'Priority', cell: (r) => <PriorityBadge value={r.claim_priority} /> },
            { key: 'estimated_loss', header: 'Est. loss', className: 'tabular', cell: (r) => formatMoney(r.estimated_loss) },
            { key: 'risk_flags', header: 'Risk flags', cell: (r) => (r.risk_flags?.length ? `${r.risk_flags.length} (${r.risk_flags.filter((f) => f.severity === 'HIGH' && !f.resolved).length} high open)` : 'None') },
            { key: 'reviewer_name', header: 'Reviewer', cell: (r) => r.reviewer_name || '—' },
            { key: 'created_at', header: 'Opened', cell: (r) => formatRelative(r.created_at) },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
    </MotionPage>
  )
}
