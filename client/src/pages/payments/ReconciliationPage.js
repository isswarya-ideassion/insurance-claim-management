import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Clock, Landmark, XCircle } from 'lucide-react'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { KpiCard } from '@/components/common/KpiCard.js'
import { SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { CardsSkeleton, ErrorState } from '@/components/common/States.js'
import { ChartCard, SimpleBarChart, rowsHeight } from '@/components/dashboard/Charts.js'
import { SimulatedNotice } from '@/components/payments/PaymentDetailPanel.js'
import { formatMoney, formatRelative, humanize } from '@/utils/format.js'

export default function ReconciliationPage() {
  const query = useApiQuery(() => paymentsService.reconciliation(), [])
  const d = query.data
  const total = (status) => d?.byStatus.find((s) => s.status === status) || { count: 0, total: 0 }
  const paymentRows = [
    { key: 'claim_number', header: 'Claim', cell: (p) => <Link to={`/payments/${p.id}`} className="font-medium text-primary hover:underline">{p.claim_number}</Link> },
    { key: 'amount', header: 'Amount', className: 'tabular', cell: (p) => formatMoney(p.amount) },
    { key: 'portal_reference', header: 'Reference', cell: (p) => p.portal_reference || '—' },
    { key: 'issued_at', header: 'Issued', cell: (p) => formatRelative(p.issued_at || p.updated_at) },
  ]

  return (
    <MotionPage>
      <PageHeader title="Reconciliation" description="Confirm paid settlements against statements and investigate failures." />
      <div className="mb-4"><SimulatedNotice /></div>
      {query.error && <ErrorState error={query.error} onRetry={query.reload} />}
      {!d && !query.error && <CardsSkeleton />}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard index={0} label="Paid, awaiting reconciliation" value={total('PAID').count} hint={formatMoney(total('PAID').total)} icon={Clock} tone="amber" />
            <KpiCard index={1} label="Reconciled" value={total('RECONCILED').count} hint={formatMoney(total('RECONCILED').total)} icon={CheckCircle2} tone="green" />
            <KpiCard index={2} label="Failed payments" value={total('FAILED').count} hint={formatMoney(total('FAILED').total)} icon={XCircle} tone="red" to="/payments?status=FAILED" />
            <KpiCard index={3} label="Attempt success rate" value={d.attempts.successRate == null ? '—' : `${Math.round(d.attempts.successRate * 100)}%`} hint={`${d.attempts.succeeded} succeeded · ${d.attempts.failed} failed`} icon={Landmark} tone="teal" />
          </div>
          {d.stuckProcessing.length > 0 && (
            <div role="alert" className="mt-5 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <AlertTriangle className="mt-0.5 size-4" /> {d.stuckProcessing.length} payment(s) have been processing for over 15 minutes and need investigation.
            </div>
          )}
          <div className="mt-6 grid gap-5 xl:grid-cols-5">
            <SectionCard title="Paid — awaiting reconciliation" className="xl:col-span-3" bodyClassName="p-0">
              <DataTable rows={d.unreconciled} columns={paymentRows} empty={<p className="p-4 text-sm text-muted-foreground">Everything paid has been reconciled.</p>} />
            </SectionCard>
            <ChartCard
              className="xl:col-span-2"
              title="Failure reasons"
              description="Failed payment attempts by code"
              data={d.failureReasons.map((f) => ({ label: humanize(f.code), count: f.count }))}
              columns={[{ key: 'label', header: 'Reason' }, { key: 'count', header: 'Attempts' }]}
              empty="No failed attempts"
              height={rowsHeight(d.failureReasons)}
            >
              <SimpleBarChart data={d.failureReasons.map((f) => ({ label: humanize(f.code), count: f.count }))} horizontal color="var(--chart-5)" />
            </ChartCard>
          </div>
        </>
      )}
    </MotionPage>
  )
}
