import { Link } from 'react-router-dom'
import { FilePlus2, FileText, RotateCcw } from 'lucide-react'
import { POLICY_TYPES, POLICY_TYPE_LABELS } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { Pagination } from '@/components/common/DataTable.js'
import { EmptyState } from '@/components/common/States.js'
import { ClaimTable } from '@/components/claims/ClaimTable.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { toDateTimeLocal } from '@/utils/format.js'

const STATUS_FILTERS = [
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'SUBMITTED,POLICY_VERIFICATION,DOCUMENT_REVIEW,ADJUSTER_ASSIGNMENT,INVESTIGATION,RESERVE_APPROVAL,COMPLIANCE_REVIEW,SETTLEMENT_APPROVAL,ON_HOLD,REOPENED', label: 'In progress' },
  { value: 'DOCUMENTS_REQUIRED', label: 'Action required' },
  { value: 'PAYMENT_PENDING,PAYMENT_FAILED,PAID', label: 'Payment stage' },
  { value: 'CLOSED,REJECTED,WITHDRAWN', label: 'Closed' },
]

// "Submitted in" windows, counted back from today.
const DURATIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 3 months' },
  { value: '365', label: 'Last 12 months' },
]

export function submittedSince(days, now = new Date()) {
  if (!days) return undefined
  const from = new Date(now)
  from.setDate(from.getDate() - Number(days))
  return toDateTimeLocal(from).slice(0, 10)
}

export default function MyClaimsPage() {
  const { params, setParams, reset } = useListParams({ sort: 'updated_at', order: 'desc' })
  const { duration, ...rest } = params
  const query = useApiQuery(() => claimsService.list({ ...rest, from: submittedSince(duration) }), [JSON.stringify(params)])
  const filtered = Boolean(params.status || params.claimType || duration)
  return (
    <MotionPage>
      <PageHeader title="My claims" description="Every claim you have started or submitted." actions={<Button asChild><Link to="/customer/claims/new"><FilePlus2 /> New claim</Link></Button>} />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4" role="group" aria-label="Filter claims">
          <div className="w-full sm:w-48">
            <Select aria-label="Status" value={params.status || ''} allowClear placeholder="All statuses" onValueChange={(status) => setParams({ status })} options={STATUS_FILTERS} />
          </div>
          <div className="w-full sm:w-44">
            <Select aria-label="Claim type" value={params.claimType || ''} allowClear placeholder="All claim types" onValueChange={(claimType) => setParams({ claimType })} options={POLICY_TYPES.map((t) => ({ value: t, label: POLICY_TYPE_LABELS[t] }))} />
          </div>
          <div className="w-full sm:w-44">
            <Select aria-label="Submitted in" value={duration || ''} allowClear placeholder="Any time" onValueChange={(d) => setParams({ duration: d })} options={DURATIONS} />
          </div>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={reset} className="sm:ml-auto">
              <RotateCcw /> Clear filters
            </Button>
          )}
        </div>
        <ClaimTable
          variant="customer"
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={
            filtered ? (
              <EmptyState icon={FileText} title="No claims match these filters" action={<Button size="sm" variant="outline" onClick={reset}>Clear filters</Button>} />
            ) : (
              <EmptyState icon={FileText} title="No claims yet" action={<Button asChild size="sm"><Link to="/customer/claims/new">Start a claim</Link></Button>} />
            )
          }
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
    </MotionPage>
  )
}
