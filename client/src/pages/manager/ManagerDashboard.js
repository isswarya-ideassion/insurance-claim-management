import { Link } from 'react-router-dom'
import { AlarmClock, Gavel, Scale, ShieldAlert, UserX, Users } from 'lucide-react'
import { ROLE_LABELS } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { approvalsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { KpiCard } from '@/components/common/KpiCard.js'
import { SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { ChartCard, SimpleBarChart, rowsHeight } from '@/components/dashboard/Charts.js'
import { Button } from '@/components/ui/button.js'
import { Badge } from '@/components/ui/badge.js'
import { useAuth } from '@/context/AuthContext.js'
import { formatAuthority, formatMoney } from '@/utils/format.js'

export default function ManagerDashboard() {
  const { user } = useAuth()
  const stats = useApiQuery(() => claimsService.stats(), [])
  const workload = useApiQuery(() => claimsService.workload(), [])
  const reserves = useApiQuery(() => approvalsService.reserveQueue({ pageSize: 1 }), [])
  const settlements = useApiQuery(() => approvalsService.settlementQueue({ pageSize: 1, awaitingMe: 'true' }), [])
  const unassigned = useApiQuery(() => claimsService.list({ needsAdjuster: 'true', pageSize: 1 }), [])
  const s = stats.data

  return (
    <MotionPage>
      <PageHeader
        title="Team workload"
        description={`Reserve authority: ${formatAuthority(user.limits, 'reserve')}. Settlement authority: ${formatAuthority(user.limits, 'settlement')}.`}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/manager/reserves">Reserve reviews</Link></Button>
            <Button asChild><Link to="/settlements">Settlement approvals</Link></Button>
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard index={0} label="Need adjuster" value={unassigned.meta?.total} icon={UserX} tone="amber" to="/manager/unassigned" />
        <KpiCard index={1} label="Reserve approvals" value={reserves.meta?.total} icon={Scale} tone="navy" to="/manager/reserves" />
        <KpiCard index={2} label="Settlements above adjuster limit" value={settlements.meta?.total} icon={Gavel} tone="navy" to="/settlements" />
        <KpiCard index={3} label="On hold / in compliance" value={s ? s.onHold + s.inCompliance : null} icon={ShieldAlert} tone="red" to="/compliance" />
        <KpiCard index={4} label="Overdue tasks" value={s?.overdueTasks} icon={AlarmClock} tone="red" to="/tasks?view=team&overdue=true" />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-5">
        <SectionCard title="Workload by team member" description="Active claims and open tasks per person" className="xl:col-span-3" bodyClassName="p-0">
          <DataTable
            rows={workload.data}
            loading={workload.loading}
            error={workload.error}
            onRetry={workload.reload}
            columns={[
              { key: 'full_name', header: 'Team member', cell: (r) => <span className="font-medium">{r.full_name}</span> },
              { key: 'roles', header: 'Role', cell: (r) => <div className="flex flex-wrap gap-1">{r.roles.map((x) => <Badge key={x} tone="neutral">{ROLE_LABELS[x]}</Badge>)}</div> },
              { key: 'active_claims', header: 'Active claims', className: 'tabular text-right', headerClassName: 'text-right' },
              { key: 'high_priority', header: 'High / urgent', className: 'tabular text-right', headerClassName: 'text-right' },
              { key: 'overdue_claims', header: 'Claims past SLA', className: 'tabular text-right', headerClassName: 'text-right', cell: (r) => <span className={r.overdue_claims ? 'font-medium text-red-700' : ''}>{r.overdue_claims}</span> },
              { key: 'open_tasks', header: 'Open tasks', className: 'tabular text-right', headerClassName: 'text-right' },
              { key: 'overdue_tasks', header: 'Overdue tasks', className: 'tabular text-right', headerClassName: 'text-right', cell: (r) => <span className={r.overdue_tasks ? 'font-medium text-red-700' : ''}>{r.overdue_tasks}</span> },
            ]}
            empty={<p className="p-4 text-sm text-muted-foreground">No team members found.</p>}
          />
        </SectionCard>
        <ChartCard
          className="xl:col-span-2"
          title="Active claims per person"
          data={workload.data?.filter((w) => w.active_claims > 0).map((w) => ({ label: w.full_name, count: w.active_claims })) || []}
          columns={[{ key: 'label', header: 'Team member' }, { key: 'count', header: 'Active claims' }]}
          height={rowsHeight(workload.data?.filter((w) => w.active_claims > 0))}
        >
          <SimpleBarChart data={workload.data?.filter((w) => w.active_claims > 0).map((w) => ({ label: w.full_name, count: w.active_claims })) || []} horizontal color="var(--chart-2)" />
        </ChartCard>
      </div>
      <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="size-4" /> Assign or rebalance work from the <Link to="/manager/unassigned" className="font-medium text-accent hover:underline">unassigned claims</Link> list or any claim workspace.
      </div>
    </MotionPage>
  )
}
