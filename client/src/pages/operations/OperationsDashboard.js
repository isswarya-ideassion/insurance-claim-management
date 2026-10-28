import { Link } from 'react-router-dom'
import { AlarmClock, Archive, ClipboardCheck, FileClock, FileSearch, Flag, Gavel, Inbox, Layers, Wallet } from 'lucide-react'
import { claimsService } from '@/services/claimsService.js'
import { tasksService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { KpiCard, KpiGrid } from '@/components/common/KpiCard.js'
import { CardsSkeleton, ErrorState } from '@/components/common/States.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { ChartCard, SimpleBarChart, rowsHeight } from '@/components/dashboard/Charts.js'
import { ClaimTable } from '@/components/claims/ClaimTable.js'
import { TaskTable } from '@/components/tasks/TaskComponents.js'
import { SectionCard } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { STATUS_LABELS } from '@shared/constants.js'

const PIPELINE = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT', 'INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'ON_HOLD']

export default function OperationsDashboard() {
  const stats = useApiQuery(() => claimsService.stats(), [])
  // New claims are routed to a named Claims Operations Manager, so the dashboard leads with the user's own intake work.
  const mine = useApiQuery(() => claimsService.list({ assigneeId: 'me', status: 'SUBMITTED,POLICY_VERIFICATION,DOCUMENTS_REQUIRED,DOCUMENT_REVIEW,ADJUSTER_ASSIGNMENT', sort: 'opened_at', order: 'asc', pageSize: 8 }), [])
  const tasks = useApiQuery(() => tasksService.list({ view: 'mine', status: 'OPEN,IN_PROGRESS', pageSize: 6 }), [])
  const s = stats.data

  const pipeline = s ? PIPELINE.map((status) => ({ label: STATUS_LABELS[status], count: s.byStatus.find((b) => b.status === status)?.count || 0 })) : []

  return (
    <MotionPage>
      <PageHeader title="Claims Operations" description="New claims are assigned to you automatically. Verify coverage, collect and verify payee details, and route each claim." actions={<Button asChild><Link to="/claims">Open claims queue</Link></Button>} />
      {stats.error && <ErrorState error={stats.error} onRetry={stats.reload} />}
      {!s && !stats.error ? (
        <CardsSkeleton count={10} />
      ) : s ? (
        <KpiGrid>
          <KpiCard index={0} label="Total claims" value={s.total} icon={Layers} tone="slate" to="/claims" />
          <KpiCard index={1} label="Newly submitted" value={s.newlySubmitted} icon={Inbox} tone="navy" to="/claims?status=SUBMITTED" />
          <KpiCard index={2} label="Awaiting verification" value={s.awaitingVerification} icon={ClipboardCheck} tone="navy" to="/claims?status=POLICY_VERIFICATION" />
          <KpiCard index={3} label="Awaiting documents" value={s.awaitingDocuments} icon={FileClock} tone="amber" to="/claims?status=DOCUMENTS_REQUIRED" />
          <KpiCard index={4} label="Under investigation" value={s.underInvestigation} icon={FileSearch} tone="teal" to="/claims?status=INVESTIGATION" />
          <KpiCard index={5} label="Awaiting approval" value={s.awaitingApproval} icon={Gavel} tone="amber" hint="Reserve + settlement" to="/claims?status=RESERVE_APPROVAL" />
          <KpiCard index={6} label="Awaiting payment" value={s.awaitingPayment} icon={Wallet} tone="teal" to="/claims?status=PAYMENT_PENDING" />
          <KpiCard index={7} label="Overdue tasks" value={s.overdueTasks} icon={AlarmClock} tone="red" hint={`${s.overdueClaims} claims past SLA`} to="/tasks?overdue=true" />
          <KpiCard index={8} label="Escalated" value={s.escalated} icon={Flag} tone="red" to="/claims?escalated=true" />
          <KpiCard index={9} label="Closed claims" value={s.closed} icon={Archive} tone="green" to="/claims?status=CLOSED" />
        </KpiGrid>
      ) : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-5">
        <ChartCard
          className="xl:col-span-3"
          title="Open pipeline by stage"
          description="Claims currently in each workflow stage"
          data={pipeline.filter((p) => p.count > 0).length ? pipeline : []}
          columns={[{ key: 'label', header: 'Stage' }, { key: 'count', header: 'Claims' }]}
          height={rowsHeight(pipeline)}
        >
          <SimpleBarChart data={pipeline} horizontal />
        </ChartCard>
        <SectionCard title="My open tasks" className="xl:col-span-2" bodyClassName="p-0" actions={<Button size="sm" variant="ghost" asChild><Link to="/tasks">View all</Link></Button>}>
          <TaskTable compact rows={tasks.data} loading={tasks.loading} error={tasks.error} onRetry={tasks.reload} onChanged={tasks.reload} />
        </SectionCard>
      </div>

      <SectionCard title="Assigned to you — in intake, oldest first" className="mt-5" bodyClassName="p-0" actions={<Button size="sm" variant="ghost" asChild><Link to="/claims?assigneeId=me">View all</Link></Button>}>
        <ClaimTable rows={mine.data} loading={mine.loading} error={mine.error} onRetry={mine.reload} hideColumns={['assignee']} />
      </SectionCard>
    </MotionPage>
  )
}
