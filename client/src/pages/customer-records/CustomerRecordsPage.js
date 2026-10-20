import { useNavigate } from 'react-router-dom'
import { Download, Users } from 'lucide-react'
import { POLICY_TYPES, POLICY_TYPE_LABELS } from '@shared/constants.js'
import { customersService } from '@/services/automationService.js'
import { saveBlob } from '@/services/documentsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { SearchInput } from '@/components/common/SearchInput.js'
import { EmptyState } from '@/components/common/States.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { formatDate } from '@/utils/format.js'

const FILTER_KEYS = ['search', 'policyType', 'policyStatus', 'hasOpenClaims', 'status', 'possibleDuplicate']

export default function CustomerRecordsPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const { params, setParams, reset } = useListParams({ pageSize: 25, sort: 'name', direction: 'asc' })
  const query = useApiQuery(() => customersService.list(params), [JSON.stringify(params)])
  const action = useAction()
  const filtered = FILTER_KEYS.some((k) => params[k])

  async function exportCsv() {
    const filters = Object.fromEntries(Object.entries(params).filter(([k]) => FILTER_KEYS.includes(k) || k === 'sort' || k === 'direction'))
    await action.run(async () => {
      const blob = await customersService.exportCsv(filters)
      saveBlob(blob, `customer-records-${new Date().toISOString().slice(0, 10)}.csv`)
    }, { success: 'Export downloaded (the export is recorded in the audit log)' })
  }

  return (
    <MotionPage>
      <PageHeader
        title="Customer records"
        description={`Every customer in one place for record keeping. Records are retained for ${query.meta?.retentionYears ?? '…'} years after last activity.`}
        actions={
          can('customers.export') && (
            <Button variant="outline" onClick={exportCsv} loading={action.pending}>
              <Download /> Export CSV
            </Button>
          )
        }
      />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <SearchInput
            value={params.search || ''}
            onChange={(search) => setParams({ search })}
            placeholder="Name, ID, phone, email or policy no."
            className="w-full sm:w-80"
          />
          <div className="w-full sm:w-44">
            <Select aria-label="Policy type" allowClear placeholder="Any policy type" value={params.policyType || ''} onValueChange={(policyType) => setParams({ policyType })} options={POLICY_TYPES.map((t) => ({ value: t, label: POLICY_TYPE_LABELS[t] }))} />
          </div>
          <div className="w-full sm:w-44">
            <Select aria-label="Policy status" allowClear placeholder="Any policy status" value={params.policyStatus || ''} onValueChange={(policyStatus) => setParams({ policyStatus })} options={['ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
          </div>
          <div className="w-full sm:w-44">
            <Select aria-label="Open claims" allowClear placeholder="Any claims" value={params.hasOpenClaims || ''} onValueChange={(hasOpenClaims) => setParams({ hasOpenClaims })} options={[{ value: 'true', label: 'With open claims' }, { value: 'false', label: 'No open claims' }]} />
          </div>
          <div className="w-full sm:w-40">
            <Select aria-label="Account status" allowClear placeholder="Any status" value={params.status || ''} onValueChange={(status) => setParams({ status })} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-teal-600" checked={params.possibleDuplicate === 'true'} onChange={(e) => setParams({ possibleDuplicate: e.target.checked ? 'true' : '' })} />
            Possible duplicates
          </label>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={reset}>
              Clear filters
            </Button>
          )}
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          caption="Customer records"
          onRowClick={(c) => navigate(`/customer-records/${c.id}`)}
          sort={{ field: params.sort, order: params.direction }}
          onSortChange={(sort, direction) => setParams({ sort, direction })}
          empty={<EmptyState icon={Users} title="No customers match" description="Try a different search or clear the filters." />}
          columns={[
            {
              key: 'name',
              header: 'Customer',
              sortable: true,
              cell: (c) => (
                <div className="min-w-0">
                  <p className="font-medium">{c.full_name || '—'}</p>
                  <p className="text-xs text-muted-foreground">{c.email}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{c.id.slice(0, 8)}</p>
                </div>
              ),
            },
            { key: 'phone', header: 'Phone', cell: (c) => c.phone || '—' },
            { key: 'policy_numbers', header: 'Policies', cell: (c) => <span className="text-xs">{c.policy_numbers || '—'}</span> },
            {
              key: 'claim_count',
              header: 'Claims',
              sortable: true,
              cell: (c) => (
                <span className="tabular">
                  {c.claim_count}
                  {c.open_claim_count > 0 && <span className="ml-1 text-xs text-muted-foreground">({c.open_claim_count} open)</span>}
                </span>
              ),
            },
            { key: 'last_claim_at', header: 'Last claim', sortable: true, cell: (c) => formatDate(c.last_claim_at) },
            { key: 'last_activity_at', header: 'Retain until', sortable: true, cell: (c) => formatDate(c.retain_until) },
            {
              key: 'flags',
              header: 'Status',
              cell: (c) => (
                <div className="flex flex-wrap gap-1">
                  {c.is_active ? <Badge tone="green" dot>Active</Badge> : <Badge tone="neutral" dot>Deactivated</Badge>}
                  {c.possible_duplicate && <Badge tone="amber">Possible duplicate</Badge>}
                </div>
              ),
            },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
    </MotionPage>
  )
}
