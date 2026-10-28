import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { ALL_STATUSES, STATUS_LABELS, POLICY_TYPES, POLICY_TYPE_LABELS, PRIORITIES, humanize } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { SearchInput } from '@/components/common/SearchInput.js'
import { Select } from '@/components/ui/select.js'
import { Input, Label } from '@/components/ui/input.js'
import { Switch } from '@/components/ui/misc.js'
import { Button } from '@/components/ui/button.js'

/** Search and filter controls for staff claim queues; values live in URL params. */
export function ClaimFilters({ params, setParams, reset, showAssignee = true, statusOptions = ALL_STATUSES.filter((s) => s !== 'DRAFT') }) {
  const [assignees, setAssignees] = useState([])

  useEffect(() => {
    if (!showAssignee) return
    Promise.all([claimsService.assignees('CLAIMS_OPERATIONS'), claimsService.assignees('CLAIMS_ADJUSTER'), claimsService.assignees('DOCUMENT_REVIEWER')])
      .then((lists) => {
        const seen = new Map()
        lists.flat().forEach((u) => seen.set(u.id, u))
        setAssignees([...seen.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)))
      })
      .catch(() => setAssignees([]))
  }, [showAssignee])

  return (
    <div className="space-y-3 border-b p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchInput value={params.search || ''} onChange={(search) => setParams({ search })} placeholder="Claim ID, claimant or policy number" className="lg:w-80" label="Search claims" />
        <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4">
          <Select aria-label="Status" placeholder="All statuses" allowClear value={params.status || ''} onValueChange={(status) => setParams({ status })} options={statusOptions.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} />
          <Select aria-label="Claim type" placeholder="All types" allowClear value={params.claimType || ''} onValueChange={(claimType) => setParams({ claimType })} options={POLICY_TYPES.map((t) => ({ value: t, label: POLICY_TYPE_LABELS[t] }))} />
          <Select aria-label="Priority" placeholder="All priorities" allowClear value={params.priority || ''} onValueChange={(priority) => setParams({ priority })} options={PRIORITIES.map((p) => ({ value: p, label: humanize(p) }))} />
          {showAssignee && (
            <Select
              aria-label="Assignee"
              placeholder="Any assignee"
              allowClear
              value={params.assigneeId || ''}
              onValueChange={(assigneeId) => setParams({ assigneeId })}
              options={[{ value: 'me', label: 'Assigned to me' }, { value: 'unassigned', label: 'Unassigned' }, ...assignees.map((a) => ({ value: a.id, label: a.full_name }))]}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="filter-from" className="text-xs text-muted-foreground">Submitted from</Label>
            <Input id="filter-from" type="date" value={params.from || ''} onChange={(e) => setParams({ from: e.target.value })} className="h-8 w-40" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="filter-to" className="text-xs text-muted-foreground">to</Label>
            <Input id="filter-to" type="date" value={params.to || ''} onChange={(e) => setParams({ to: e.target.value })} className="h-8 w-40" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={params.overdue === 'true'} onCheckedChange={(v) => setParams({ overdue: v ? 'true' : '' })} aria-label="Overdue only" />
          Overdue only
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={params.escalated === 'true'} onCheckedChange={(v) => setParams({ escalated: v ? 'true' : '' })} aria-label="Escalated only" />
          Escalated
        </label>
        <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">
          <RotateCcw /> Reset filters
        </Button>
      </div>
    </div>
  )
}
