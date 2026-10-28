import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, Flag } from 'lucide-react'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { DataTable } from '@/components/common/DataTable.js'
import { ClaimStatusBadge, PriorityBadge } from '@/components/common/StatusBadge.js'
import { Tooltip } from '@/components/ui/misc.js'
import { formatDate, formatMoney, formatRelative } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

export function ClaimTable({ rows, loading, error, onRetry, sort, onSortChange, variant = 'staff', empty, hideColumns = [] }) {
  const navigate = useNavigate()
  const base = variant === 'customer' ? '/customer/claims' : '/claims'
  const linkFor = (c) => (variant === 'customer' && c.status === 'DRAFT' ? `/customer/claims/${c.id}/edit` : `${base}/${c.id}`)

  const staffColumns = [
    {
      key: 'claim_number',
      header: 'Claim',
      sortable: true,
      cell: (c) => (
        <div className="min-w-[9rem]">
          <Link to={linkFor(c)} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            {c.claim_number}
          </Link>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {c.policy_number}
            {c.escalation_level > 0 && (
              <Tooltip content={`Escalation level ${c.escalation_level}`}>
                <Flag className="size-3 text-orange-600" aria-label={`Escalated level ${c.escalation_level}`} />
              </Tooltip>
            )}
          </div>
        </div>
      ),
    },
    { key: 'customer_name', header: 'Claimant', cell: (c) => <span className="whitespace-nowrap">{c.customer_name || c.insured_name}</span> },
    { key: 'claim_type', header: 'Type', cell: (c) => POLICY_TYPE_LABELS[c.claim_type] || '—' },
    { key: 'status', header: 'Status', sortable: true, cell: (c) => <ClaimStatusBadge status={c.status} /> },
    { key: 'priority', header: 'Priority', sortable: true, cell: (c) => <PriorityBadge value={c.priority} /> },
    { key: 'estimated_loss', header: 'Est. loss', sortable: true, className: 'tabular text-right', headerClassName: 'text-right', cell: (c) => formatMoney(c.estimated_loss) },
    {
      key: 'assignee',
      header: 'Owner / Adjuster',
      cell: (c) => (
        <div className="text-xs leading-tight">
          <div>{c.assigned_owner_name || <span className="text-muted-foreground">Unassigned</span>}</div>
          {c.assigned_adjuster_name && <div className="text-muted-foreground">{c.assigned_adjuster_name}</div>}
        </div>
      ),
    },
    { key: 'submitted_at', header: 'Submitted', sortable: true, cell: (c) => <span className="whitespace-nowrap">{formatDate(c.submitted_at)}</span> },
    {
      key: 'due_date',
      header: 'Due',
      sortable: true,
      cell: (c) =>
        c.due_date ? (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', c.is_overdue && 'font-medium text-red-700')}>
            {c.is_overdue && <AlertTriangle className="size-3.5" aria-label="Overdue" />}
            {formatRelative(c.due_date)}
          </span>
        ) : (
          '—'
        ),
    },
  ]

  const customerColumns = [
    {
      key: 'claim_number',
      header: 'Claim',
      cell: (c) => (
        <Link to={linkFor(c)} className="font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.claim_number || 'Draft claim'}
        </Link>
      ),
    },
    { key: 'claim_type', header: 'Type', cell: (c) => POLICY_TYPE_LABELS[c.claim_type] || '—' },
    { key: 'incident_category', header: 'Incident', cell: (c) => c.incident_category?.replaceAll('_', ' ').toLowerCase() || '—' },
    { key: 'status', header: 'Status', cell: (c) => <ClaimStatusBadge status={c.status} customer label={c.status_label} /> },
    { key: 'estimated_loss', header: 'Estimated loss', className: 'tabular', cell: (c) => formatMoney(c.estimated_loss) },
    { key: 'submitted_at', header: 'Submitted', cell: (c) => (c.submitted_at ? formatDate(c.submitted_at) : 'Not submitted') },
    { key: 'updated_at', header: 'Last update', cell: (c) => formatRelative(c.updated_at) },
  ]

  const columns = (variant === 'customer' ? customerColumns : staffColumns).filter((c) => !hideColumns.includes(c.key))
  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={(c) => navigate(linkFor(c))}
      empty={empty}
      caption="Claims"
    />
  )
}
