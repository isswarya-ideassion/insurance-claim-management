import { useState } from 'react'
import { Plus } from 'lucide-react'
import { tasksService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { SectionCard } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { CreateTaskDialog, TaskTable } from '@/components/tasks/TaskComponents.js'

export function TasksTab({ detail, reload }) {
  const { claim } = detail
  const { can } = useAuth()
  const query = useApiQuery(() => tasksService.forClaim(claim.id), [claim.id, claim.status])
  const [open, setOpen] = useState(false)
  const refresh = async () => {
    await query.reload()
    reload()
  }
  return (
    <SectionCard
      title="Tasks"
      description="Mandatory tasks must be completed or cancelled before the claim can close."
      bodyClassName="p-0"
      actions={
        can('tasks.create') && !['CLOSED', 'WITHDRAWN'].includes(claim.status) && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New task
          </Button>
        )
      }
    >
      <TaskTable rows={query.data} loading={query.loading} error={query.error} onRetry={query.reload} onChanged={refresh} showClaim={false} />
      <CreateTaskDialog open={open} onOpenChange={setOpen} claimId={claim.id} onCreated={refresh} />
    </SectionCard>
  )
}
