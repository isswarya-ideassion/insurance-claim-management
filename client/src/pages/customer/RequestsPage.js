import { ARTIFACT_STATUS_LABELS } from '@shared/constants.js'
import { documentsService } from '@/services/documentsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { QueryState } from '@/components/common/States.js'
import { Pagination } from '@/components/common/DataTable.js'
import { Select } from '@/components/ui/select.js'
import { InformationRequestList } from '@/components/documents/InformationRequests.js'

export default function RequestsPage() {
  const { params, setParams } = useListParams({ status: 'REQUESTED' })
  const query = useApiQuery(() => documentsService.requests(params), [JSON.stringify(params)])
  return (
    <MotionPage className="max-w-4xl">
      <PageHeader title="Information requests" description="Documents or details our team needs to continue with your claims." />
      <div className="mb-4 w-52">
        <Select aria-label="Request status" allowClear placeholder="All requests" value={params.status || ''} onValueChange={(status) => setParams({ status })} options={['REQUESTED', 'RECEIVED', 'ACCEPTED', 'CLOSED', 'CANCELLED'].map((s) => ({ value: s, label: ARTIFACT_STATUS_LABELS[s] }))} />
      </div>
      <QueryState query={query}>
        {(rows, meta) => (
          <>
            <InformationRequestList requests={rows} customer showClaim onChanged={query.reload} />
            {meta && meta.totalPages > 1 && <Pagination meta={meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} className="mt-4 rounded-xl border bg-card" />}
          </>
        )}
      </QueryState>
    </MotionPage>
  )
}
