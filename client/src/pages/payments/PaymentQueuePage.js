import { useState } from 'react'
import { Link } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ShieldAlert, Wallet } from 'lucide-react'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { ClaimStatusBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Select } from '@/components/ui/select.js'
import { SheetContent } from '@/components/ui/dialog.js'
import { PaymentDetailPanel, SimulatedNotice } from '@/components/payments/PaymentDetailPanel.js'
import { formatMoney, formatRelative } from '@/utils/format.js'

const VIEWS = {
  queue: { title: 'Approved settlements awaiting payment', description: 'Process pending payments and resolve failures.', status: 'PENDING,FAILED,PROCESSING' },
  history: { title: 'Payment history', description: 'All payment requests and their outcomes.', status: '' },
}

export default function PaymentQueuePage({ view = 'queue' }) {
  const config = VIEWS[view]
  const { params, setParams } = useListParams({ status: config.status })
  const query = useApiQuery(() => paymentsService.list(params), [view, JSON.stringify(params)])
  const [selected, setSelected] = useState(null)

  return (
    <MotionPage>
      <PageHeader title={config.title} description={config.description} />
      <div className="mb-4"><SimulatedNotice /></div>
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-52">
            <Select
              aria-label="Payment status"
              allowClear={view === 'history'}
              placeholder="All statuses"
              value={params.status || ''}
              onValueChange={(status) => setParams({ status })}
              options={
                view === 'queue'
                  ? [{ value: 'PENDING,FAILED,PROCESSING', label: 'Pending, failed & processing' }, { value: 'PENDING', label: 'Pending' }, { value: 'FAILED', label: 'Failed' }, { value: 'PROCESSING', label: 'Processing' }]
                  : ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))
              }
            />
          </div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          onRowClick={(p) => setSelected(p.id)}
          empty={<EmptyState icon={Wallet} title={view === 'queue' ? 'No payments waiting' : 'No payments found'} />}
          columns={[
            { key: 'claim_number', header: 'Claim', cell: (p) => <Link to={`/payments/${p.id}`} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{p.claim_number}</Link> },
            { key: 'customer_name', header: 'Claimant' },
            { key: 'amount', header: 'Amount', className: 'tabular font-medium', cell: (p) => formatMoney(p.amount) },
            { key: 'payee', header: 'Paying to', cell: (p) => <span>{p.payee_name} <span className="font-mono text-xs text-muted-foreground">{p.payee_account_masked}</span></span> },
            { key: 'status', header: 'Payment', cell: (p) => <div className="flex items-center gap-1.5"><StatusBadge value={p.status} />{p.compliance_hold && <ShieldAlert className="size-4 text-red-600" aria-label="Compliance hold" />}</div> },
            { key: 'claim_status', header: 'Claim', cell: (p) => <ClaimStatusBadge status={p.claim_status} /> },
            { key: 'attempt_count', header: 'Attempts', className: 'tabular' },
            { key: 'open_blocks', header: 'Blocks', cell: (p) => (p.open_blocks ? <span className="text-xs font-medium text-red-700">{p.open_blocks} open</span> : '—') },
            { key: 'payee_verification', header: 'Payee', cell: (p) => (p.payee_verification ? <StatusBadge value={p.payee_verification} /> : '—') },
            { key: 'last_failure_reason', header: 'Last failure', cell: (p) => (p.last_failure_reason ? <span className="text-xs text-red-700">{p.last_failure_reason}</span> : '—') },
            { key: 'portal_reference', header: 'Reference', cell: (p) => p.portal_reference || '—' },
            { key: 'updated_at', header: 'Updated', cell: (p) => formatRelative(p.updated_at) },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <DialogPrimitive.Root open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent title="Payment request" description="Details, payee, approval steps, blocks and attempts" className="max-w-2xl">
          <div className="p-6">{selected && <PaymentDetailPanel paymentId={selected} onChanged={query.reload} />}</div>
        </SheetContent>
      </DialogPrimitive.Root>
    </MotionPage>
  )
}
