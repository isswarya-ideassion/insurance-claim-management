import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { Pagination } from '@/components/common/DataTable.js'
import { ClaimFilters } from './ClaimFilters.js'
import { ClaimTable } from './ClaimTable.js'

/** Filterable, sortable, paginated claim list backed by GET /claims. `fixed` params are always applied. */
export function ClaimsListPanel({ fixed = {}, defaults = {}, showFilters = true, showAssignee = true, empty, hideColumns }) {
  const { params, setParams, reset } = useListParams({ sort: 'opened_at', order: 'desc', ...defaults })
  const effective = { ...params, ...fixed }
  const key = JSON.stringify(effective)
  const query = useApiQuery(() => claimsService.list(effective), [key])

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      {showFilters && <ClaimFilters params={params} setParams={setParams} reset={reset} showAssignee={showAssignee} />}
      <ClaimTable
        rows={query.data}
        loading={query.loading}
        error={query.error}
        onRetry={query.reload}
        sort={{ field: params.sort, order: params.order }}
        onSortChange={(sort, order) => setParams({ sort, order })}
        empty={empty}
        hideColumns={hideColumns}
      />
      <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} onPageSizeChange={(pageSize) => setParams({ pageSize })} />
    </div>
  )
}
