import { useEffect, useState } from 'react'
import { AlertOctagon, CheckCircle2, Flag, Plus, Save, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { COMPLIANCE_CHECKLIST, RISK_FLAG_CODES, humanize } from '@shared/constants.js'
import { complianceService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField, KeyValue, SectionCard } from '@/components/common/FormField.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Checkbox, Switch } from '@/components/ui/misc.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime } from '@/utils/format.js'

const OPEN = ['PENDING', 'IN_REVIEW', 'HOLD', 'ESCALATED']

function ReviewEditor({ review, onChanged }) {
  const action = useAction()
  const [form, setForm] = useState(null)
  const [decision, setDecision] = useState(null)

  useEffect(() => {
    setForm({ checklist: review.checklist || {}, riskFlags: review.risk_flags || [], evidence: review.evidence || [], decisionNotes: review.decision_notes || '', escalationNotes: review.escalation_notes || '' })
  }, [review])
  if (!form) return null
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const save = (silent) =>
    action.run(async () => {
      const r = await complianceService.update(review.id, {
        checklist: form.checklist,
        riskFlags: form.riskFlags.map((f) => ({ ...f, note: f.note || null })),
        evidence: form.evidence.filter((e) => e.description?.trim().length >= 2),
        decisionNotes: form.decisionNotes || null,
        escalationNotes: form.escalationNotes || null,
      })
      onChanged()
      return r
    }, { success: silent ? undefined : 'Review saved' })

  const DECISIONS = {
    CLEAR: { title: 'Clear compliance review', description: 'All checks passed. If the claim is in compliance review it advances to settlement approval and a settlement request is created.', label: 'Clear', variant: 'accent', reason: false },
    HOLD: { title: 'Place compliance hold', description: 'Blocks settlement approval, payment and closure until cleared or an exception is approved.', label: 'Place hold', variant: 'destructive', reason: true },
    EXCEPTION: { title: 'Approve compliance exception', description: 'Permits the workflow to continue despite unresolved findings. Your justification is recorded permanently.', label: 'Approve exception', variant: 'default', reason: true, min: 20 },
    ESCALATE: { title: 'Escalate to management', description: 'The claim remains blocked and claims managers are notified.', label: 'Escalate', variant: 'default', reason: true },
  }
  const d = decision && DECISIONS[decision]

  return (
    <SectionCard
      title="Current review"
      description={`Opened ${formatDateTime(review.created_at)}${review.created_by_name ? ` by ${review.created_by_name}` : ''}`}
      actions={
        <>
          <StatusBadge value={review.status} />
          <Button size="sm" variant="outline" onClick={() => save(false)} loading={action.pending}>
            <Save /> Save
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">Review checklist</p>
            <ul className="mt-2 space-y-2">
              {COMPLIANCE_CHECKLIST.map((item) => (
                <li key={item.key} className="flex items-start gap-2.5">
                  <Checkbox id={`cmp-${item.key}`} checked={Boolean(form.checklist[item.key])} onCheckedChange={(v) => set('checklist', { ...form.checklist, [item.key]: v === true })} className="mt-0.5" />
                  <label htmlFor={`cmp-${item.key}`} className="text-sm">{item.label}</label>
                </li>
              ))}
            </ul>
          </div>
          <FormField label="Decision notes">
            <Textarea value={form.decisionNotes} onChange={(e) => set('decisionNotes', e.target.value)} />
          </FormField>
          <FormField label="Escalation notes">
            <Textarea value={form.escalationNotes} onChange={(e) => set('escalationNotes', e.target.value)} />
          </FormField>
        </div>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">Risk flags & exceptions</p>
            <ul className="mt-2 space-y-2">
              {form.riskFlags.map((f, i) => (
                <li key={i} className="space-y-2 rounded-lg border p-3">
                  <div className="grid grid-cols-[1fr_7rem_auto] gap-2">
                    <Select aria-label="Flag" value={f.code} onValueChange={(code) => set('riskFlags', form.riskFlags.map((x, j) => (j === i ? { ...x, code } : x)))} options={RISK_FLAG_CODES.map((c) => ({ value: c, label: humanize(c) }))} />
                    <Select aria-label="Severity" value={f.severity} onValueChange={(severity) => set('riskFlags', form.riskFlags.map((x, j) => (j === i ? { ...x, severity } : x)))} options={['LOW', 'MEDIUM', 'HIGH'].map((s) => ({ value: s, label: humanize(s) }))} />
                    <Button size="icon" variant="ghost" aria-label="Remove flag" onClick={() => set('riskFlags', form.riskFlags.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <Input placeholder="Note" value={f.note || ''} onChange={(e) => set('riskFlags', form.riskFlags.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} aria-label="Flag note" />
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={Boolean(f.resolved)} onCheckedChange={(resolved) => set('riskFlags', form.riskFlags.map((x, j) => (j === i ? { ...x, resolved } : x)))} aria-label="Resolved" />
                    Resolved
                  </label>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => set('riskFlags', [...form.riskFlags, { code: 'OTHER', severity: 'MEDIUM', note: '', resolved: false }])}>
              <Plus /> Add risk flag
            </Button>
          </div>
          <div>
            <p className="text-sm font-medium">Supporting evidence</p>
            <ul className="mt-2 space-y-2">
              {form.evidence.map((ev, i) => (
                <li key={i} className="flex gap-2">
                  <Input value={ev.description} onChange={(e) => set('evidence', form.evidence.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label={`Evidence ${i + 1}`} />
                  <Button size="icon" variant="ghost" aria-label="Remove evidence" onClick={() => set('evidence', form.evidence.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => set('evidence', [...form.evidence, { description: '' }])}>
              <Plus /> Add evidence
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
        <Button variant="accent" size="sm" onClick={async () => (await save(true)) && setDecision('CLEAR')}>
          <ShieldCheck /> Clear
        </Button>
        {review.status !== 'HOLD' && (
          <Button variant="destructive" size="sm" onClick={async () => (await save(true)) && setDecision('HOLD')}>
            <ShieldAlert /> Place hold
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={async () => (await save(true)) && setDecision('EXCEPTION')}>
          <CheckCircle2 /> Approve exception
        </Button>
        {review.status !== 'ESCALATED' && (
          <Button variant="outline" size="sm" onClick={async () => (await save(true)) && setDecision('ESCALATE')}>
            <Flag /> Escalate
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(decision)}
        onOpenChange={(o) => !o && setDecision(null)}
        title={d?.title}
        description={d?.description}
        confirmLabel={d?.label}
        variant={d?.variant}
        requireReason={d?.reason}
        reasonMinLength={d?.min || 5}
        reasonLabel={decision === 'EXCEPTION' ? 'Exception justification' : 'Notes'}
        onConfirm={async (text) =>
          Boolean(
            await action.run(async () => {
              const body = { decision, notes: decision === 'EXCEPTION' ? form.decisionNotes || undefined : text || form.decisionNotes || undefined }
              if (decision === 'EXCEPTION') body.exceptionReason = text
              const r = await complianceService.decide(review.id, body)
              onChanged()
              return r
            }, { success: 'Compliance decision recorded' }),
          )
        }
      />
    </SectionCard>
  )
}

export function ComplianceTab({ detail, reload }) {
  const { claim } = detail
  const { can } = useAuth()
  const query = useApiQuery(() => complianceService.forClaim(claim.id), [claim.id, claim.status])
  const action = useAction()
  const [openDialog, setOpenDialog] = useState(false)
  const [newReview, setNewReview] = useState({ placeHold: false, notes: '' })
  const canReview = can('compliance.review')
  const refresh = async () => {
    await query.reload()
    reload()
  }

  return (
    <QueryState query={query}>
      {(rows) => {
        const open = rows.find((r) => OPEN.includes(r.status))
        const history = rows.filter((r) => r !== open || !canReview)
        return (
          <div className="space-y-5">
            {canReview && open && <ReviewEditor review={open} onChanged={refresh} />}
            {canReview && !open && !['CLOSED', 'WITHDRAWN', 'DRAFT'].includes(claim.status) && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-6 text-center">
                <p className="text-sm text-muted-foreground">No open compliance review. Open one to record findings or place a hold at any stage.</p>
                <Button variant="outline" onClick={() => { setNewReview({ placeHold: false, notes: '' }); setOpenDialog(true) }}>
                  <AlertOctagon /> Open compliance review
                </Button>
              </div>
            )}
            <SectionCard title="Compliance history">
              {history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No compliance reviews recorded.</p>
              ) : (
                <ul className="space-y-3">
                  {history.map((r) => (
                    <li key={r.id} className="rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium">Review opened {formatDateTime(r.created_at)}</p>
                        <div className="flex items-center gap-2">
                          {r.hold_active && <span className="text-xs font-semibold text-red-700">HOLD ACTIVE</span>}
                          <StatusBadge value={r.status} />
                        </div>
                      </div>
                      <KeyValue
                        className="mt-3"
                        columns={3}
                        items={[
                          { label: 'Reviewer', value: r.reviewer_name },
                          { label: 'Decided by', value: r.decided_by_name },
                          { label: 'Decided', value: formatDateTime(r.decided_at) },
                          r.hold_placed_by_name && { label: 'Hold placed by', value: `${r.hold_placed_by_name} · ${formatDateTime(r.hold_placed_at)}` },
                          r.decision_notes && { label: 'Notes', value: r.decision_notes, wide: true },
                          r.exception_reason && { label: 'Exception justification', value: r.exception_reason, wide: true },
                          r.escalation_notes && { label: 'Escalation notes', value: r.escalation_notes, wide: true },
                          r.risk_flags?.length > 0 && {
                            label: 'Risk flags',
                            wide: true,
                            value: (
                              <ul className="space-y-1">
                                {r.risk_flags.map((f, i) => (
                                  <li key={i}>
                                    <strong>{humanize(f.code)}</strong> ({humanize(f.severity)}){f.resolved ? ' — resolved' : ''}{f.note ? `: ${f.note}` : ''}
                                  </li>
                                ))}
                              </ul>
                            ),
                          },
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <Dialog open={openDialog} onOpenChange={setOpenDialog}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Open compliance review</DialogTitle>
                  <DialogDescription>Optionally place an immediate hold, which blocks settlement, payment and closure.</DialogDescription>
                </DialogHeader>
                <FormField label="Reason / findings" required>
                  <Textarea value={newReview.notes} onChange={(e) => setNewReview((n) => ({ ...n, notes: e.target.value }))} />
                </FormField>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={newReview.placeHold} onCheckedChange={(placeHold) => setNewReview((n) => ({ ...n, placeHold }))} aria-label="Place hold immediately" />
                  Place compliance hold immediately
                </label>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpenDialog(false)}>Cancel</Button>
                  <Button
                    variant={newReview.placeHold ? 'destructive' : 'default'}
                    loading={action.pending}
                    disabled={newReview.notes.trim().length < 5}
                    onClick={async () => {
                      const ok = await action.run(() => complianceService.open(claim.id, { placeHold: newReview.placeHold, notes: newReview.notes, riskFlags: [] }), { success: newReview.placeHold ? 'Compliance hold placed' : 'Review opened' })
                      if (ok) {
                        setOpenDialog(false)
                        refresh()
                      }
                    }}
                  >
                    {newReview.placeHold ? 'Open review & place hold' : 'Open review'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        )
      }}
    </QueryState>
  )
}
