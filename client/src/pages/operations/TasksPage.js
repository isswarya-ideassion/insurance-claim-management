import { useState } from 'react'
import { Plus } from 'lucide-react'
import { tasksService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { Pagination } from '@/components/common/DataTable.js'
import { CreateTaskDialog, TaskTable } from '@/components/tasks/TaskComponents.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { Switch } from '@/components/ui/misc.js'

export default function TasksPage() {
  const { hasRole, can } = useAuth()
  const { params, setParams } = useListParams({ view: 'mine', status: 'OPEN,IN_PROGRESS' })
  const query = useApiQuery(() => tasksService.list(params), [JSON.stringify(params)])
  const [open, setOpen] = useState(false)
  const teamAllowed = hasRole('CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'COMPLIANCE_SECURITY')

  return (
    <MotionPage>
      <PageHeader
        title="Tasks"
        description="Work assigned to you or your team, with due dates and overdue tracking."
        actions={can('tasks.create') && <Button onClick={() => setOpen(true)}><Plus /> New task</Button>}
      />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          {teamAllowed && (
            <div className="w-44">
              <Select aria-label="View" value={params.view} onValueChange={(view) => setParams({ view })} options={[{ value: 'mine', label: 'My tasks' }, { value: 'team', label: 'Team tasks' }]} />
            </div>
          )}
          <div className="w-48">
            <Select
              aria-label="Status"
              value={params.status}
              onValueChange={(status) => setParams({ status })}
              options={[
                { value: 'OPEN,IN_PROGRESS', label: 'Open & in progress' },
                { value: 'DONE', label: 'Completed' },
                { value: 'CANCELLED', label: 'Cancelled' },
                { value: 'OPEN,IN_PROGRESS,DONE,CANCELLED', label: 'All' },
              ]}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={params.overdue === 'true'} onCheckedChange={(v) => setParams({ overdue: v ? 'true' : '' })} aria-label="Overdue only" />
            Overdue only
          </label>
        </div>
        <TaskTable rows={query.data} loading={query.loading} error={query.error} onRetry={query.reload} onChanged={query.reload} />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <CreateTaskDialog open={open} onOpenChange={setOpen} onCreated={query.reload} />
    </MotionPage>
  )
}
