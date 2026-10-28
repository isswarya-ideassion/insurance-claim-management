import { useState } from 'react'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { SectionCard } from '@/components/common/FormField.js'
import { QueryState } from '@/components/common/States.js'
import { DataTable } from '@/components/common/DataTable.js'
import { Timeline } from '@/components/claims/Timeline.js'
import { Button } from '@/components/ui/button.js'
import { formatDateTime } from '@/utils/format.js'

const FILTERS = [
  { key: 'ALL', label: 'All activity' },
  { key: 'STATUS', label: 'Status changes' },
  { key: 'DOCUMENT', label: 'Documents' },
  { key: 'NOTES', label: 'Notes' },
  { key: 'AUDIT', label: 'Audit events' },
]

export function ActivityTab({ detail }) {
  const { claim } = detail
  const timeline = useApiQuery(() => claimsService.timeline(claim.id), [claim.id, claim.updated_at])
  const assignments = useApiQuery(() => claimsService.assignments(claim.id), [claim.id, claim.updated_at])
  const [filter, setFilter] = useState('ALL')

  const match = (e) =>
    filter === 'ALL' ||
    e.type === filter ||
    (filter === 'NOTES' && (e.type === 'INTERNAL_NOTE' || e.type === 'CUSTOMER_NOTE')) ||
    (filter === 'DOCUMENT' && e.type === 'REQUEST')

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <SectionCard
        title="Activity timeline"
        className="xl:col-span-2"
        actions={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter activity">
            {FILTERS.map((f) => (
              <Button key={f.key} size="sm" variant={filter === f.key ? 'secondary' : 'ghost'} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
                {f.label}
              </Button>
            ))}
          </div>
        }
      >
        <QueryState query={timeline}>{(events) => <Timeline events={events.filter(match)} />}</QueryState>
      </SectionCard>
      <SectionCard title="Assignment history" bodyClassName="p-0">
        <QueryState query={assignments}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No assignments yet.</p>}
              columns={[
                { key: 'assignment_role', header: 'Role', cell: (a) => a.assignment_role.replace('_', ' ').toLowerCase() },
                { key: 'assignee_name', header: 'Assignee', cell: (a) => <span className={a.is_active ? 'font-medium' : 'text-muted-foreground line-through'}>{a.assignee_name}</span> },
                { key: 'assigned_at', header: 'When', cell: (a) => <span title={a.reason || ''}>{formatDateTime(a.assigned_at)}</span> },
              ]}
            />
          )}
        </QueryState>
      </SectionCard>
    </div>
  )
}
