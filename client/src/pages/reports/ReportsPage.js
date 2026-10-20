import { AlarmClock, FileClock, Landmark, Timer } from 'lucide-react'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { reportsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { KpiCard } from '@/components/common/KpiCard.js'
import { SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { CardsSkeleton, ErrorState } from '@/components/common/States.js'
import { ChartCard, SimpleBarChart, TrendAreaChart, rowsHeight } from '@/components/dashboard/Charts.js'
import { Input, Label } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { formatDate, formatMoney, humanize, toDateInput } from '@/utils/format.js'

export default function ReportsPage() {
  const { params, setParams } = useListParams({ from: toDateInput(Date.now() - 180 * 86400000), to: toDateInput(Date.now()), granularity: 'week' })
  const query = useApiQuery(() => reportsService.summary({ from: params.from, to: params.to, granularity: params.granularity }), [params.from, params.to, params.granularity])
  const r = query.data

  const byDate = r?.claimsByDate.map((d) => ({ label: formatDate(d.period), count: d.count })) || []
  const byType = r?.claimsByType.map((t) => ({ label: POLICY_TYPE_LABELS[t.claim_type] || t.claim_type, count: t.count, claimed: t.claimed })) || []
  const turnaround = r?.approvalTurnaround.map((t) => ({ label: humanize(t.approval_type), hours: t.avg_hours, decisions: t.decisions, approved: t.approved, returned: t.returned, rejected: t.rejected })) || []
  const paymentAttempts = r ? [{ label: 'Succeeded', count: r.payments.attempts.succeeded }, { label: 'Failed', count: r.payments.attempts.failed }].filter((x) => x.count > 0) : []

  return (
    <MotionPage>
      <PageHeader title="Reports & analytics" description={r ? `Live data across ${r.scope.claims} claims in your authorized scope.` : 'Live data across claims in your authorized scope.'} />

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4 shadow-sm">
        <div className="space-y-1">
          <Label htmlFor="r-from" className="text-xs text-muted-foreground">From</Label>
          <Input id="r-from" type="date" value={params.from} onChange={(e) => setParams({ from: e.target.value })} className="h-9 w-44" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="r-to" className="text-xs text-muted-foreground">To</Label>
          <Input id="r-to" type="date" value={params.to} onChange={(e) => setParams({ to: e.target.value })} className="h-9 w-44" />
        </div>
        <div className="w-40 space-y-1">
          <Label className="text-xs text-muted-foreground">Group by</Label>
          <Select aria-label="Group by" value={params.granularity} onValueChange={(granularity) => setParams({ granularity })} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
        </div>
        <p className="ml-auto text-xs text-muted-foreground">Status, aging, overdue and request figures reflect current state; volumes, processing time, turnaround and payments use the selected range.</p>
      </div>

      {query.error && <ErrorState error={query.error} onRetry={query.reload} />}
      {!r && !query.error && <CardsSkeleton />}
      {r && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard index={0} label="Avg. processing time" value={r.processingTime.avgDays != null ? `${r.processingTime.avgDays} days` : '—'} hint={`Median ${r.processingTime.medianDays ?? '—'} days · ${r.processingTime.closed} closed`} icon={Timer} tone="navy" />
            <KpiCard index={1} label="Overdue tasks" value={r.overdueTasks.total} icon={AlarmClock} tone="red" />
            <KpiCard index={2} label="Outstanding document requests" value={r.outstandingDocumentRequests.total} hint={`Avg age ${r.outstandingDocumentRequests.avgAgeDays ?? 0} days · ${r.outstandingDocumentRequests.overdue} overdue`} icon={FileClock} tone="amber" />
            <KpiCard index={3} label="Payment success rate" value={r.payments.attempts.successRate != null ? `${r.payments.attempts.successRate}%` : '—'} hint={`${r.payments.attempts.succeeded} succeeded · ${r.payments.attempts.failed} failed (simulated)`} icon={Landmark} tone="teal" />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard title="Claims submitted over time" description={`Per ${params.granularity}`} data={byDate} columns={[{ key: 'label', header: 'Period' }, { key: 'count', header: 'Claims' }]}>
              <TrendAreaChart data={byDate} />
            </ChartCard>
            <ChartCard title="Claims by status" description="Current status of all claims in scope" data={r.claimsByStatus} columns={[{ key: 'label', header: 'Status' }, { key: 'count', header: 'Claims' }]} height={rowsHeight(r.claimsByStatus)}>
              <SimpleBarChart data={r.claimsByStatus} horizontal color="var(--chart-2)" />
            </ChartCard>
            <ChartCard title="Claims by type" description="Submitted in range" data={byType} columns={[{ key: 'label', header: 'Type' }, { key: 'count', header: 'Claims' }, { key: 'claimed', header: 'Claimed', format: (v) => formatMoney(v) }]}>
              <SimpleBarChart data={byType} />
            </ChartCard>
            <ChartCard title="Claim aging" description="Open claims by days since submission" data={r.claimAging.some((a) => a.count) ? r.claimAging.map((a) => ({ label: a.bucket, count: a.count })) : []} columns={[{ key: 'label', header: 'Age' }, { key: 'count', header: 'Open claims' }]}>
              <SimpleBarChart data={r.claimAging.map((a) => ({ label: a.bucket, count: a.count }))} color="var(--chart-3)" />
            </ChartCard>
            <ChartCard
              title="Approval turnaround"
              description="Average hours from request to decision"
              data={turnaround}
              columns={[{ key: 'label', header: 'Type' }, { key: 'hours', header: 'Avg hours' }, { key: 'decisions', header: 'Decisions' }, { key: 'approved', header: 'Approved' }, { key: 'returned', header: 'Returned' }, { key: 'rejected', header: 'Rejected' }]}
            >
              <SimpleBarChart data={turnaround} y="hours" format={(v) => `${v}h`} color="var(--chart-4)" />
            </ChartCard>
            <ChartCard title="Payment attempts" description="Success vs failure in range (simulated adapter)" data={paymentAttempts} columns={[{ key: 'label', header: 'Outcome' }, { key: 'count', header: 'Attempts' }]}>
              <SimpleBarChart data={paymentAttempts} colorBy={(d) => (d.label === 'Failed' ? 'var(--chart-5)' : 'var(--chart-1)')} />
            </ChartCard>
            <ChartCard title="Overdue tasks by assignee" data={r.overdueTasks.byAssignee.map((o) => ({ label: o.assignee, count: o.count }))} columns={[{ key: 'label', header: 'Assignee' }, { key: 'count', header: 'Overdue tasks' }]} empty="No overdue tasks" height={rowsHeight(r.overdueTasks.byAssignee)}>
              <SimpleBarChart data={r.overdueTasks.byAssignee.map((o) => ({ label: o.assignee, count: o.count }))} horizontal color="var(--chart-5)" />
            </ChartCard>
            <ChartCard title="Outstanding document requests" description="Open requests by category" data={r.outstandingDocumentRequests.byCategory.map((c) => ({ label: humanize(c.category), count: c.count }))} columns={[{ key: 'label', header: 'Category' }, { key: 'count', header: 'Open requests' }]} empty="No outstanding requests" height={rowsHeight(r.outstandingDocumentRequests.byCategory)}>
              <SimpleBarChart data={r.outstandingDocumentRequests.byCategory.map((c) => ({ label: humanize(c.category), count: c.count }))} horizontal color="var(--chart-3)" />
            </ChartCard>
          </div>

          {r.adjusterWorkload && (
            <div className="grid gap-5 xl:grid-cols-2">
              <SectionCard title="Adjuster workload" bodyClassName="p-0">
                <DataTable
                  rows={r.adjusterWorkload}
                  columns={[
                    { key: 'full_name', header: 'Adjuster' },
                    { key: 'active_claims', header: 'Active', className: 'tabular text-right', headerClassName: 'text-right' },
                    { key: 'investigating', header: 'Investigating', className: 'tabular text-right', headerClassName: 'text-right' },
                    { key: 'overdue', header: 'Past SLA', className: 'tabular text-right', headerClassName: 'text-right' },
                  ]}
                />
              </SectionCard>
              <SectionCard title="Team productivity" description="Completed work in the selected range" bodyClassName="p-0">
                <DataTable
                  rows={r.teamProductivity}
                  empty={<p className="p-4 text-sm text-muted-foreground">No completed work in this range.</p>}
                  columns={[
                    { key: 'full_name', header: 'Team member' },
                    { key: 'tasks_completed', header: 'Tasks', className: 'tabular text-right', headerClassName: 'text-right' },
                    { key: 'documents_reviewed', header: 'Docs reviewed', className: 'tabular text-right', headerClassName: 'text-right' },
                    { key: 'assessments_submitted', header: 'Assessments', className: 'tabular text-right', headerClassName: 'text-right' },
                    { key: 'approvals_decided', header: 'Approvals', className: 'tabular text-right', headerClassName: 'text-right' },
                  ]}
                />
              </SectionCard>
            </div>
          )}
        </div>
      )}
    </MotionPage>
  )
}
