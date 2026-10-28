import { AlarmClock, Briefcase, FileSearch, Gavel } from 'lucide-react'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { KpiCard } from '@/components/common/KpiCard.js'
import { EmptyState } from '@/components/common/States.js'
import { ClaimsListPanel } from '@/components/claims/ClaimsListPanel.js'

export default function AdjusterDashboard() {
  const { user } = useAuth()
  const stats = useApiQuery(() => claimsService.stats(), [])
  const s = stats.data
  return (
    <MotionPage>
      <PageHeader title="My assigned claims" description="Claims where you are the assigned adjuster. Open a claim and use the Evaluation tab to record your evaluation and reserve." />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Assigned claims" value={s ? s.total - s.closed - s.rejected : null} icon={Briefcase} tone="navy" index={0} />
        <KpiCard label="Under investigation" value={s?.underInvestigation} icon={FileSearch} tone="teal" index={1} />
        <KpiCard label="Awaiting approval" value={s?.awaitingApproval} icon={Gavel} tone="amber" index={2} />
        <KpiCard label="My overdue tasks" value={s?.overdueTasks} icon={AlarmClock} tone="red" to="/tasks?overdue=true" index={3} />
      </div>
      <ClaimsListPanel
        fixed={{ assigneeId: user.id }}
        defaults={{ sort: 'due_date', order: 'asc' }}
        showAssignee={false}
        empty={<EmptyState icon={Briefcase} title="No assigned claims" description="Claims assigned to you by a manager will appear here." />}
      />
    </MotionPage>
  )
}
