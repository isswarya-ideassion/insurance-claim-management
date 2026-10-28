import { useEffect, useState } from 'react'
import { DoorClosed, Plus } from 'lucide-react'
import { RECOVERY_STATUSES, RECOVERY_TYPES, humanize } from '@shared/constants.js'
import { closureService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField, SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDate, formatDateTime, formatMoney, todayInput } from '@/utils/format.js'

// Mirrors the server rule: closure can be requested once the claim is paid or denied.
const CLOSABLE_STATUSES = ['PAID', 'REJECTED']

function RecoveryDialog({ open, onOpenChange, claimId, recovery, onSaved }) {
  const editing = Boolean(recovery)
  const [form, setForm] = useState({})
  const action = useAction()
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }))

  useEffect(() => {
    if (!open) return
    setForm({
      type: recovery?.type || 'SUBROGATION',
      status: recovery?.status || 'IDENTIFIED',
      targetParty: recovery?.target_party || '',
      description: recovery?.description || '',
      expectedAmount: recovery?.expected_amount ?? '',
      recoveredAmount: recovery?.recovered_amount ?? '',
      deadline: recovery?.deadline ? String(recovery.deadline).slice(0, 10) : '',
    })
  }, [open, recovery])

  const money = (v) => (v === '' || v == null ? null : Number(v))
  async function submit() {
    const common = { targetParty: form.targetParty || null, description: form.description || null, expectedAmount: money(form.expectedAmount), deadline: form.deadline || null }
    const result = await action.run(
      () =>
        editing
          ? closureService.updateRecovery(recovery.id, { ...common, status: form.status, recoveredAmount: money(form.recoveredAmount) ?? 0 })
          : closureService.createRecovery(claimId, { ...common, type: form.type }),
      { success: editing ? 'Recovery updated' : 'Recovery opened' },
    )
    if (result) {
      onOpenChange(false)
      onSaved?.()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Update recovery' : 'Open recovery'}</DialogTitle>
          <DialogDescription>Subrogation against a liable third party, or salvage of damaged property.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Type" required>
            <Select value={form.type} onValueChange={set('type')} disabled={editing} options={RECOVERY_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
          </FormField>
          {editing && (
            <FormField label="Status">
              <Select value={form.status} onValueChange={set('status')} options={RECOVERY_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
            </FormField>
          )}
          <FormField label="Target party" className="sm:col-span-2">
            <Input value={form.targetParty || ''} onChange={set('targetParty')} placeholder="Third party, insurer or salvage buyer" />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <Textarea value={form.description || ''} onChange={set('description')} />
          </FormField>
          <FormField label="Expected amount (₹)">
            <Input type="number" min="0" step="0.01" value={form.expectedAmount} onChange={set('expectedAmount')} />
          </FormField>
          {editing && (
            <FormField label="Recovered so far (₹)">
              <Input type="number" min="0" step="0.01" value={form.recoveredAmount} onChange={set('recoveredAmount')} />
            </FormField>
          )}
          <FormField label="Deadline">
            <Input type="date" min={todayInput()} value={form.deadline || ''} onChange={set('deadline')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={action.pending}>
            {editing ? 'Save' : 'Open recovery'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RecoveryTab({ detail, reload }) {
  const { claim } = detail
  const { can, user } = useAuth()
  const requests = useApiQuery(() => closureService.requests(claim.id), [claim.id, claim.status])
  const recoveries = useApiQuery(() => closureService.recoveries(claim.id), [claim.id, claim.status])
  const action = useAction()
  const [requestOpen, setRequestOpen] = useState(false)
  const [deciding, setDeciding] = useState(null)
  const [recoveryDialog, setRecoveryDialog] = useState(null)

  const pending = (requests.data || []).find((r) => r.status === 'PENDING')
  const canRequest = can('claims.requestClosure') && claim.assigned_adjuster_id === user.id && CLOSABLE_STATUSES.includes(claim.status) && !pending
  const canDecide = can('claims.decideClosure')
  const refresh = async () => {
    await Promise.all([requests.reload(), recoveries.reload()])
    reload()
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="Closure requests"
        description="The assigned adjuster requests closure once the claim is paid or denied; a Claims Manager approves it. Approval releases any remaining reserve."
        bodyClassName="p-0"
        actions={
          canRequest && (
            <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}>
              <DoorClosed /> Request closure
            </Button>
          )
        }
      >
        <QueryState query={requests}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No closure requests.</p>}
              columns={[
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
                { key: 'reason', header: 'Reason', cell: (r) => <span className="whitespace-pre-line">{r.reason}</span> },
                { key: 'requested_by_name', header: 'Requested by' },
                { key: 'created_at', header: 'Requested', cell: (r) => formatDateTime(r.created_at) },
                { key: 'decided_by_name', header: 'Decided by', cell: (r) => (r.decided_by_name ? `${r.decided_by_name} · ${formatDateTime(r.decided_at)}` : '—') },
                { key: 'decision_comment', header: 'Comment', cell: (r) => r.decision_comment || '—' },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (r) =>
                    r.status === 'PENDING' && canDecide && r.requested_by !== user.id ? (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="accent" onClick={() => setDeciding({ request: r, decision: 'APPROVED' })}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => setDeciding({ request: r, decision: 'REJECTED' })}>Reject</Button>
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Recoveries"
        description="Subrogation and salvage tracked after payment."
        bodyClassName="p-0"
        actions={
          can('recoveries.write') && (
            <Button size="sm" variant="outline" onClick={() => setRecoveryDialog({ recovery: null })}>
              <Plus /> Open recovery
            </Button>
          )
        }
      >
        <QueryState query={recoveries}>
          {(rows) => (
            <DataTable
              rows={rows}
              empty={<p className="p-4 text-sm text-muted-foreground">No recoveries recorded.</p>}
              columns={[
                { key: 'type', header: 'Type', cell: (r) => humanize(r.type) },
                { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
                { key: 'target_party', header: 'Target', cell: (r) => r.target_party || '—' },
                { key: 'expected_amount', header: 'Expected', className: 'tabular', cell: (r) => formatMoney(r.expected_amount) },
                { key: 'recovered_amount', header: 'Recovered', className: 'tabular', cell: (r) => formatMoney(r.recovered_amount) },
                { key: 'deadline', header: 'Deadline', cell: (r) => formatDate(r.deadline) },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  cell: (r) =>
                    can('recoveries.write') ? (
                      <Button size="sm" variant="ghost" onClick={() => setRecoveryDialog({ recovery: r })}>Update</Button>
                    ) : null,
                },
              ]}
            />
          )}
        </QueryState>
      </SectionCard>

      <ConfirmDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        title="Request claim closure"
        description="A Claims Manager reviews the request. Open blocking tasks and pending compliance holds still prevent closure."
        requireReason
        reasonLabel="Why the claim can be closed"
        confirmLabel="Send request"
        onConfirm={async (reason) => Boolean(await action.run(async () => { await closureService.request(claim.id, reason); await refresh() }, { success: 'Closure requested' }))}
      />
      <ConfirmDialog
        open={Boolean(deciding)}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.decision === 'APPROVED' ? 'Approve closure' : 'Reject closure request'}
        description={deciding?.decision === 'APPROVED' ? 'The claim closes and any remaining reserve is released through a closure ledger entry.' : 'The adjuster is notified with your reason.'}
        requireReason={deciding?.decision === 'REJECTED'}
        reasonLabel="Reason"
        confirmLabel={deciding?.decision === 'APPROVED' ? 'Approve and close' : 'Reject request'}
        onConfirm={async (comment) => Boolean(await action.run(async () => { await closureService.decide(deciding.request.id, { decision: deciding.decision, comment: comment || undefined }); await refresh() }, { success: deciding?.decision === 'APPROVED' ? 'Claim closed' : 'Closure request rejected' }))}
      />
      <RecoveryDialog open={Boolean(recoveryDialog)} onOpenChange={(o) => !o && setRecoveryDialog(null)} claimId={claim.id} recovery={recoveryDialog?.recovery} onSaved={refresh} />
    </div>
  )
}
