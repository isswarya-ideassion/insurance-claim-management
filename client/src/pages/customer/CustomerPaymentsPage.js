import { Link } from 'react-router-dom'
import { FlaskConical, Wallet } from 'lucide-react'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable } from '@/components/common/DataTable.js'
import { EmptyState } from '@/components/common/States.js'
import { ClaimStatusBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { formatDateTime, formatMoney } from '@/utils/format.js'

export default function CustomerPaymentsPage() {
  const query = useApiQuery(() => paymentsService.mine(), [])
  const anySimulated = query.data?.some((r) => r.payment?.isSimulated)
  return (
    <MotionPage>
      <PageHeader title="Settlements & payments" description="Approved settlements and the status of each payment." />
      {anySimulated && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" /> Demonstration environment: payments shown here are simulated and no money is transferred.
        </p>
      )}
      <div className="rounded-xl border bg-card shadow-sm">
        <DataTable
          rows={query.data}
          rowKey={(r) => r.claimId}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={<EmptyState icon={Wallet} title="No claims yet" />}
          columns={[
            { key: 'claimNumber', header: 'Claim', cell: (r) => <Link to={`/customer/claims/${r.claimId}?tab=payment`} className="font-medium text-primary hover:underline">{r.claimNumber}</Link> },
            { key: 'claimType', header: 'Type', cell: (r) => POLICY_TYPE_LABELS[r.claimType] },
            { key: 'claimStatus', header: 'Claim status', cell: (r) => <ClaimStatusBadge status={r.claimStatus} customer /> },
            { key: 'settlement', header: 'Approved settlement', className: 'tabular', cell: (r) => (r.settlement ? formatMoney(r.settlement.amount) : <span className="text-muted-foreground">Not yet approved</span>) },
            { key: 'payment', header: 'Payment', cell: (r) => (r.payment ? <StatusBadge value={r.payment.status} label={r.payment.statusLabel} /> : '—') },
            { key: 'paidAt', header: 'Paid on', cell: (r) => formatDateTime(r.payment?.paidAt) },
            { key: 'account', header: 'Account', cell: (r) => <span className="font-mono text-xs">{r.payment?.beneficiaryAccount || '—'}</span> },
          ]}
        />
      </div>
    </MotionPage>
  )
}
