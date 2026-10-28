import { useState } from 'react'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { policiesService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { toast } from 'sonner'
import { formatDate, formatDateTime } from '@/utils/format.js'

const STATUSES = [
  { value: 'REQUESTED', label: 'Waiting for a decision' },
  { value: 'COMPLETED', label: 'Renewed' },
  { value: 'DECLINED', label: 'Declined' },
]

export default function PolicyRenewalsPage() {
  const { params, setParams } = useListParams({ status: 'REQUESTED' })
  const query = useApiQuery(() => policiesService.renewals(params), [JSON.stringify(params)])
  const [deciding, setDeciding] = useState(null)

  async function decide(decision, reason) {
    try {
      await policiesService.decideRenewal(deciding.id, { decision, reason: reason || null })
      toast.success(decision === 'COMPLETED' ? `Policy ${deciding.policy_number} renewed` : 'Renewal declined; the customer has been told why')
      await query.reload()
      return true
    } catch (err) {
      toast.error(err.message)
      return false
    }
  }

  return (
    <MotionPage>
      <PageHeader title="Policy renewals" description="Renewal requests from customers. Renewing extends the policy from its current expiry, or from today if it has already expired." />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-full sm:w-56">
            <Select aria-label="Status" value={params.status || ''} allowClear placeholder="All requests" onValueChange={(status) => setParams({ status })} options={STATUSES} />
          </div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={<EmptyState icon={RefreshCw} title="No renewal requests" description="Requests customers make from My Policies appear here." />}
          columns={[
            { key: 'requested_at', header: 'Requested', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.requested_at)}</span> },
            { key: 'policy_number', header: 'Policy', cell: (r) => <span className="font-medium">{r.policy_number}</span> },
            { key: 'insured_name', header: 'Insured' },
            { key: 'policy_type', header: 'Type', cell: (r) => POLICY_TYPE_LABELS[r.policy_type] },
            { key: 'expiry_date', header: 'Current expiry', cell: (r) => <span className="whitespace-nowrap">{formatDate(r.status === 'COMPLETED' ? r.previous_expiry : r.expiry_date)}</span> },
            { key: 'term_months', header: 'Term', cell: (r) => `${r.term_months} months` },
            { key: 'new_expiry', header: 'Renewed until', cell: (r) => <span className="whitespace-nowrap">{formatDate(r.new_expiry || r.proposed_expiry)}</span> },
            { key: 'notes', header: 'Customer note', cell: (r) => <span className="line-clamp-2 max-w-xs">{r.notes || '—'}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (r) =>
                r.canDecide ? (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="accent" onClick={() => setDeciding({ ...r, decision: 'COMPLETED' })}>
                      <CheckCircle2 /> Renew
                    </Button>
                    <Button size="sm" variant="destructive-outline" onClick={() => setDeciding({ ...r, decision: 'DECLINED' })}>
                      <XCircle /> Decline
                    </Button>
                  </div>
                ) : r.decided_by_name ? (
                  <span className="text-xs text-muted-foreground">by {r.decided_by_name}</span>
                ) : null,
            },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>

      <ConfirmDialog
        open={deciding?.decision === 'COMPLETED'}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={`Renew ${deciding?.policy_number}?`}
        description={deciding ? `The policy will run until ${formatDate(deciding.proposed_expiry)} and the customer is notified. Confirm the premium has been agreed before renewing.` : ''}
        confirmLabel="Renew policy"
        onConfirm={() => decide('COMPLETED')}
      />
      <ConfirmDialog
        open={deciding?.decision === 'DECLINED'}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={`Decline renewal of ${deciding?.policy_number}?`}
        description="The customer sees this reason on their policy."
        variant="destructive"
        requireReason
        reasonLabel="Reason for the customer"
        confirmLabel="Decline renewal"
        onConfirm={(reason) => decide('DECLINED', reason)}
      />
    </MotionPage>
  )
}
