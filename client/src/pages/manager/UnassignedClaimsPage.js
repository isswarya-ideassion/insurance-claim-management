import { useState } from 'react'
import { Link } from 'react-router-dom'
import { UserPlus, UserX } from 'lucide-react'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable } from '@/components/common/DataTable.js'
import { ClaimStatusBadge, PriorityBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { SectionCard } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { AssignDialog } from '@/components/claims/AssignDialog.js'
import { formatMoney, formatRelative } from '@/utils/format.js'

function ClaimRows({ query, onAssign, role }) {
  return (
    <DataTable
      rows={query.data}
      loading={query.loading}
      error={query.error}
      onRetry={query.reload}
      empty={<EmptyState icon={UserX} title="Nothing waiting" description="All claims in this list have an assignee." />}
      columns={[
        { key: 'claim_number', header: 'Claim', cell: (c) => <Link className="font-medium text-primary hover:underline" to={`/claims/${c.id}`}>{c.claim_number}</Link> },
        { key: 'customer_name', header: 'Claimant' },
        { key: 'status', header: 'Status', cell: (c) => <ClaimStatusBadge status={c.status} /> },
        { key: 'priority', header: 'Priority', cell: (c) => <PriorityBadge value={c.priority} /> },
        { key: 'estimated_loss', header: 'Est. loss', className: 'tabular', cell: (c) => formatMoney(c.estimated_loss) },
        { key: 'due_date', header: 'Due', cell: (c) => <span className={c.is_overdue ? 'font-medium text-red-700' : ''}>{formatRelative(c.due_date)}</span> },
        { key: 'actions', header: <span className="sr-only">Actions</span>, cell: (c) => <Button size="sm" variant="accent" onClick={() => onAssign(c, role)}><UserPlus /> Assign</Button> },
      ]}
    />
  )
}

export default function UnassignedClaimsPage() {
  const needsAdjuster = useApiQuery(() => claimsService.list({ needsAdjuster: 'true', pageSize: 50, sort: 'due_date', order: 'asc' }), [])
  const noOwner = useApiQuery(() => claimsService.list({ assigneeId: 'unassigned', pageSize: 50, sort: 'submitted_at', order: 'asc' }), [])
  const [target, setTarget] = useState(null)

  return (
    <MotionPage>
      <PageHeader title="Unassigned claims" description="Claims waiting for an adjuster or an operations owner." />
      <div className="space-y-5">
        <SectionCard title="Awaiting adjuster assignment" description="Assigning an adjuster starts the investigation." bodyClassName="p-0">
          <ClaimRows query={needsAdjuster} role="ADJUSTER" onAssign={(c, role) => setTarget({ claim: c, role })} />
        </SectionCard>
        <SectionCard title="No operations owner" bodyClassName="p-0">
          <ClaimRows query={noOwner} role="OPERATIONS_OWNER" onAssign={(c, role) => setTarget({ claim: c, role })} />
        </SectionCard>
      </div>
      <AssignDialog
        open={Boolean(target)}
        onOpenChange={(o) => !o && setTarget(null)}
        claim={target?.claim}
        defaultRole={target?.role}
        onAssigned={() => {
          needsAdjuster.reload()
          noOwner.reload()
        }}
      />
    </MotionPage>
  )
}
