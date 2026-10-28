import { Link } from 'react-router-dom'
import { FilePlus2, FileText } from 'lucide-react'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { Pagination } from '@/components/common/DataTable.js'
import { SearchInput } from '@/components/common/SearchInput.js'
import { EmptyState } from '@/components/common/States.js'
import { ClaimTable } from '@/components/claims/ClaimTable.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'

const FILTERS = [
  { value: '', label: 'All claims' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'DOCUMENTS_REQUIRED', label: 'Action required' },
  { value: 'PAYMENT_PENDING,PAYMENT_FAILED,PAID', label: 'Payment stage' },
  { value: 'CLOSED,REJECTED,WITHDRAWN', label: 'Closed' },
]

export default function MyClaimsPage() {
  const { params, setParams } = useListParams({ sort: 'updated_at', order: 'desc' })
  const query = useApiQuery(() => claimsService.list(params), [JSON.stringify(params)])
  return (
    <MotionPage>
      <PageHeader title="My claims" description="Every claim you have started or submitted." actions={<Button asChild><Link to="/customer/claims/new"><FilePlus2 /> New claim</Link></Button>} />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <SearchInput value={params.search || ''} onChange={(search) => setParams({ search })} placeholder="Search by claim number" className="w-72" />
          <div className="w-52">
            <Select aria-label="Filter claims" value={params.status || ''} allowClear placeholder="All claims" onValueChange={(status) => setParams({ status })} options={FILTERS.filter((f) => f.value)} />
          </div>
        </div>
        <ClaimTable
          variant="customer"
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={<EmptyState icon={FileText} title="No claims found" action={<Button asChild size="sm"><Link to="/customer/claims/new">Start a claim</Link></Button>} />}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
    </MotionPage>
  )
}
