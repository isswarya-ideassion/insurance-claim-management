import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Check, ListChecks, Play, Plus, X } from 'lucide-react'
import { PRIORITIES, TASK_TYPES, STAFF_ROLES, ROLE_LABELS, humanize } from '@shared/constants.js'
import { tasksService } from '@/services/workflowService.js'
import { claimsService } from '@/services/claimsService.js'
import { useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { DataTable } from '@/components/common/DataTable.js'
import { PriorityBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Checkbox } from '@/components/ui/misc.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime, formatRelative } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

export function TaskTable({ rows, loading, error, onRetry, onChanged, showClaim = true, compact = false }) {
  const { can, user } = useAuth()
  const action = useAction()
  const canUpdate = can('tasks.update')

  async function update(task, patch, message) {
    const ok = await action.run(() => tasksService.update(task.id, patch), { success: message })
    if (ok) onChanged?.()
  }

  const columns = [
    {
      key: 'title',
      header: 'Task',
      cell: (t) => (
        <div className="min-w-[14rem]">
          <p className="font-medium">
            {t.title}
            {t.is_mandatory && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Mandatory</span>}
          </p>
          {t.description && <p className="line-clamp-1 text-xs text-muted-foreground">{t.description}</p>}
        </div>
      ),
    },
    showClaim && {
      key: 'claim_number',
      header: 'Claim',
      cell: (t) => (t.claim_id ? <Link to={`/claims/${t.claim_id}?tab=tasks`} className="text-primary hover:underline">{t.claim_number}</Link> : '—'),
    },
    { key: 'task_type', header: 'Type', cell: (t) => humanize(t.task_type) },
    { key: 'assignee', header: 'Assignee', cell: (t) => t.assignee_name || (t.assigned_role ? `${ROLE_LABELS[t.assigned_role]} team` : 'Unassigned') },
    { key: 'priority', header: 'Priority', cell: (t) => <PriorityBadge value={t.priority} /> },
    {
      key: 'due_at',
      header: 'Due',
      cell: (t) =>
        t.due_at ? (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', t.is_overdue && 'font-medium text-red-700')} title={formatDateTime(t.due_at)}>
            {t.is_overdue && <AlertTriangle className="size-3.5" aria-label="Overdue" />}
            {formatRelative(t.due_at)}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: 'Status', cell: (t) => <StatusBadge value={t.status} /> },
    canUpdate && {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (t) =>
        ['OPEN', 'IN_PROGRESS'].includes(t.status) ? (
          <div className="flex justify-end gap-1">
            {t.status === 'OPEN' && (
              <Button size="icon-sm" variant="ghost" aria-label="Start task" title="Start" onClick={() => update(t, { status: 'IN_PROGRESS', ...(t.assignee_id ? {} : { assigneeId: user.id }) }, 'Task started')}>
                <Play />
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="Complete task" title="Complete" onClick={() => update(t, { status: 'DONE' }, 'Task completed')}>
              <Check />
            </Button>
            {(!t.is_mandatory || user.roles.includes('CLAIMS_MANAGER')) && (
              <Button size="icon-sm" variant="ghost" aria-label="Cancel task" title="Cancel" onClick={() => update(t, { status: 'CANCELLED' }, 'Task cancelled')}>
                <X />
              </Button>
            )}
          </div>
        ) : null,
    },
  ]
    .filter(Boolean)
    .filter((c) => !compact || !['task_type', 'assignee', 'priority'].includes(c.key))

  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={<EmptyState icon={ListChecks} title="No tasks" description="Tasks assigned to you or your team appear here." />}
      caption="Tasks"
    />
  )
}

export function CreateTaskDialog({ open, onOpenChange, claimId, onCreated }) {
  const [form, setForm] = useState({})
  const [staff, setStaff] = useState([])
  const action = useAction()

  useEffect(() => {
    if (!open) return
    setForm({ title: '', description: '', taskType: 'GENERAL', priority: 'MEDIUM', isMandatory: false, assigneeId: '', assignedRole: '', dueAt: '' })
    const roles = ['CLAIMS_OPERATIONS', 'DOCUMENT_REVIEWER', 'CLAIMS_ADJUSTER', 'CLAIMS_MANAGER', 'COMPLIANCE_OFFICER', 'PAYMENT_OPERATIONS']
    Promise.all(roles.map((r) => claimsService.assignees(r).catch(() => [])))
      .then((lists) => {
        const map = new Map()
        lists.flat().forEach((u) => map.set(u.id, u))
        setStaff([...map.values()].sort((a, b) => a.full_name.localeCompare(b.full_name)))
      })
  }, [open])

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }))

  async function submit() {
    const body = {
      claimId: claimId || undefined,
      title: form.title,
      description: form.description || undefined,
      taskType: form.taskType,
      priority: form.priority,
      isMandatory: form.isMandatory,
      assigneeId: form.assigneeId || undefined,
      assignedRole: form.assignedRole || undefined,
      dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
    }
    const result = await action.run(() => tasksService.create(body), { success: 'Task created' })
    if (result) {
      onCreated?.(result)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>{claimId ? 'The task is linked to this claim.' : 'A general task not linked to a claim.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Title" required className="sm:col-span-2">
            <Input value={form.title || ''} onChange={set('title')} />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <Textarea value={form.description || ''} onChange={set('description')} />
          </FormField>
          <FormField label="Type">
            <Select value={form.taskType} onValueChange={set('taskType')} options={TASK_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
          </FormField>
          <FormField label="Priority">
            <Select value={form.priority} onValueChange={set('priority')} options={PRIORITIES.map((p) => ({ value: p, label: humanize(p) }))} />
          </FormField>
          <FormField label="Assignee">
            <Select value={form.assigneeId} onValueChange={set('assigneeId')} allowClear placeholder="Unassigned" options={staff.map((s) => ({ value: s.id, label: s.full_name }))} />
          </FormField>
          <FormField label="Or team">
            <Select value={form.assignedRole} onValueChange={set('assignedRole')} allowClear placeholder="No team" options={STAFF_ROLES.filter((r) => !['AUDITOR', 'DATA_ADMIN', 'CUSTOMER_RECORDS_ADMIN'].includes(r)).map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          </FormField>
          <FormField label="Due">
            <Input type="datetime-local" value={form.dueAt || ''} onChange={set('dueAt')} />
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Checkbox checked={form.isMandatory} onCheckedChange={(v) => set('isMandatory')(v === true)} />
            Mandatory (blocks claim closure)
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={action.pending} disabled={(form.title || '').trim().length < 3}>
            <Plus /> Create task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
