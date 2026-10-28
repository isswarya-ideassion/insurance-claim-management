import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Flag, MessageSquare, ShieldAlert, ShieldCheck, StickyNote, XCircle } from 'lucide-react'

import { Link } from 'react-router-dom'
import { POLICY_TYPE_LABELS, PRIORITIES, STAGE_LABELS, humanize } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { KeyValue, SectionCard, FormField } from '@/components/common/FormField.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { PriorityBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { Button } from '@/components/ui/button.js'
import { Checkbox, Switch } from '@/components/ui/misc.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { PayeeIntake } from './PayeeIntake.js'
import { formatDateTime, formatMoney, formatRelative, toDateTimeLocal, formatLocation } from '@/utils/format.js'
import { TriageAgentCard } from '@/components/automation/AgentPanels.js'

const INTAKE_STAGES = ['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED']

/** Stage SLA clocks: running, paused (for example while the client owes documents) or stopped. */
function SlaClocks({ clocks = [] }) {
  const current = clocks.filter((c) => c.running || c.breached_at).slice(0, 3)
  if (!current.length) return null
  return (
    <SectionCard title="SLA">
      <ul className="space-y-2 text-sm">
        {current.map((c) => (
          <li key={c.id} className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium">{c.clock_type === 'ACKNOWLEDGE' ? 'Acknowledgement' : STAGE_LABELS[c.stage] || humanize(c.stage)}</p>
              <p className="text-xs text-muted-foreground">
                {c.paused_at ? `Paused${c.pause_reason ? ` · ${c.pause_reason}` : ''}` : c.due_at ? `Due ${formatRelative(c.due_at)}` : 'No target'}
              </p>
            </div>
            {c.breached_at ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700"><AlertTriangle className="size-3.5" /> Breached{c.escalation_level > 0 ? ` · L${c.escalation_level}` : ''}</span>
            ) : c.paused_at ? (
              <span className="text-xs text-muted-foreground">Paused</span>
            ) : (
              <span className="text-xs text-emerald-700">On track</span>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function IntakePanel({ detail, reload }) {
  const { claim, eligibility, intakeChecklist, coverage } = detail
  const action = useAction()
  const [notes, setNotes] = useState('')
  const [clauses, setClauses] = useState('')
  const editable = INTAKE_STAGES.includes(claim.status)

  function record(result, success) {
    const clauseRefs = clauses.split(',').map((c) => c.trim()).filter(Boolean)
    return action.run(async () => {
      await claimsService.coverageCheck(claim.id, { result, notes: notes || undefined, clauseRefs: clauseRefs.length ? clauseRefs : undefined })
      setNotes('')
      setClauses('')
      await reload()
    }, { success })
  }

  async function toggle(key, checked) {
    await action.run(async () => {
      await claimsService.updateChecklist(claim.id, { [key]: checked })
      await reload()
    })
  }

  return (
    <SectionCard title="Intake & coverage verification" description="Before the claim moves on: confirm coverage, complete the checklist, and collect and verify the payee details.">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="text-sm font-medium">Coverage verification</p>
          <div className="mt-2 rounded-lg border p-3">
            {coverage ? (
              <div className={`text-sm ${coverage.result === 'COVERED' ? 'text-emerald-700' : coverage.result === 'NOT_COVERED' ? 'text-red-700' : 'text-amber-700'}`}>
                <p className="flex items-center gap-2">
                  {coverage.result === 'COVERED' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                  {humanize(coverage.result)} · {coverage.reviewed_by_name || 'System'} · {formatDateTime(coverage.created_at)}
                </p>
                {coverage.notes && <p className="mt-1 text-xs text-muted-foreground">{coverage.notes}</p>}
                {coverage.clause_refs?.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Clauses: {coverage.clause_refs.join(', ')}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Coverage not yet verified.</p>
            )}
            {detail.policy?.from_snapshot && <p className="mt-2 text-xs text-muted-foreground">Checked against the policy snapshot frozen when the claim was opened.</p>}
            {eligibility && (
              <ul className="mt-3 space-y-1 text-xs">
                {Object.entries(eligibility.checks).map(([k, ok]) => (
                  <li key={k} className="flex items-center gap-1.5">
                    {ok ? <CheckCircle2 className="size-3.5 text-emerald-600" /> : <XCircle className="size-3.5 text-red-600" />}
                    {humanize(k.replace(/([A-Z])/g, '_$1'))}
                  </li>
                ))}
              </ul>
            )}
            {editable && (
              <div className="mt-3 space-y-2">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Coverage notes (required unless covered)" aria-label="Coverage notes" className="min-h-16" />
                <Input value={clauses} onChange={(e) => setClauses(e.target.value)} placeholder="Clause references, comma separated (optional)" aria-label="Clause references" />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="accent" loading={action.pending} disabled={!eligibility?.eligible} onClick={() => record('COVERED', 'Coverage confirmed')}>
                    <ShieldCheck /> Covered
                  </Button>
                  <Button size="sm" variant="outline" loading={action.pending} onClick={() => record('NEEDS_REVIEW', 'Coverage marked for review')}>
                    Needs review
                  </Button>
                  <Button size="sm" variant="outline" loading={action.pending} onClick={() => record('NOT_COVERED', 'Not-covered result recorded')}>
                    Not covered
                  </Button>
                </div>
                {!eligibility?.eligible && <p className="text-xs text-red-700">{eligibility?.reasons.join('; ')}</p>}
              </div>
            )}
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">Intake checklist</p>
          <ul className="mt-2 space-y-2">
            {intakeChecklist.map((item) => (
              <li key={item.key} className="flex items-start gap-2.5">
                <Checkbox id={`intake-${item.key}`} checked={item.checked} disabled={!editable || action.pending} onCheckedChange={(v) => toggle(item.key, v === true)} className="mt-0.5" />
                <label htmlFor={`intake-${item.key}`} className="text-sm leading-snug">
                  {item.label}
                  {item.checked && item.by_name && <span className="block text-xs text-muted-foreground">{item.by_name} · {formatRelative(item.at)}</span>}
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-6 border-t pt-5">
        <PayeeIntake claim={claim} onChanged={reload} />
      </div>
    </SectionCard>
  )
}

function NotesPanel({ claimId }) {
  const { can } = useAuth()
  const query = useApiQuery(() => claimsService.notes(claimId), [claimId])
  const action = useAction()
  const [body, setBody] = useState('')
  const [customerVisible, setCustomerVisible] = useState(false)
  const canInternal = can('claims.notes.internal')
  const canCustomer = can('claims.notes.customer')

  return (
    <SectionCard title="Notes" description="Internal notes are visible to staff only. Customer updates appear in the claimant's portal and notify them.">
      {canInternal && (
        <form
          className="mb-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            action.run(async () => {
              await claimsService.addNote(claimId, { body, visibility: customerVisible ? 'CUSTOMER' : 'INTERNAL' })
              setBody('')
              await query.reload()
            }, { success: customerVisible ? 'Customer update sent' : 'Note added' })
          }}
        >
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note…" aria-label="Note" />
          <div className="flex items-center justify-between">
            {canCustomer ? (
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={customerVisible} onCheckedChange={setCustomerVisible} aria-label="Visible to customer" />
                Send as customer update
              </label>
            ) : (
              <span />
            )}
            <Button size="sm" type="submit" disabled={!body.trim()} loading={action.pending}>
              Add note
            </Button>
          </div>
        </form>
      )}
      <ul className="space-y-3">
        {(query.data || []).map((n) => (
          <li key={n.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {n.visibility === 'CUSTOMER' ? <MessageSquare className="size-3.5 text-violet-600" /> : <StickyNote className="size-3.5" />}
              <span className="font-medium text-foreground">{n.author_name}</span>
              <span>· {formatRelative(n.created_at)}</span>
              {n.visibility === 'CUSTOMER' && <span className="rounded bg-violet-50 px-1.5 text-violet-700">Customer-visible</span>}
            </div>
            <p className="mt-1.5 whitespace-pre-line text-sm">{n.body}</p>
          </li>
        ))}
        {query.data?.length === 0 && <li className="text-sm text-muted-foreground">No notes yet.</li>}
      </ul>
    </SectionCard>
  )
}

export function OverviewTab({ detail, reload }) {
  const { claim, currentTask, complianceHold, duplicateOf, counts } = detail
  const { can } = useAuth()
  const action = useAction()
  const [escalateOpen, setEscalateOpen] = useState(false)
  const [exceptionOpen, setExceptionOpen] = useState(false)
  const [meta, setMeta] = useState({ priority: claim.priority, dueDate: toDateTimeLocal(claim.due_date) })

  return (
    <div className="space-y-5">
      {complianceHold && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-semibold">Active compliance hold</p>
            <p>Settlement approval, payment and closure are blocked until compliance records a clearance or an approved exception.</p>
          </div>
        </div>
      )}
      {duplicateOf && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <Copy className="size-5 shrink-0" />
          <p>
            Possible duplicate of <Link className="font-medium underline" to={`/claims/${duplicateOf.id}`}>{duplicateOf.claim_number}</Link>. The claimant confirmed this is a separate incident — verify during intake.
          </p>
        </div>
      )}
      {claim.escalation_level > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
          <Flag className="size-5 shrink-0" />
          <p>
            <strong>Escalation level {claim.escalation_level}</strong> · {formatRelative(claim.escalated_at)} — {claim.escalation_reason}
          </p>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <SectionCard title="Claim details" className="xl:col-span-2">
          <KeyValue
            items={[
              { label: 'Claim type', value: POLICY_TYPE_LABELS[claim.claim_type] },
              { label: 'Segment', value: humanize(claim.segment) },
              { label: 'Severity', value: humanize(claim.severity) },
              { label: 'Stage', value: claim.stage_label },
              claim.fraud_band && { label: 'Fraud risk', value: claim.fraud_score != null ? `${humanize(claim.fraud_band)} (${claim.fraud_score})` : humanize(claim.fraud_band) },
              { label: 'Loss type', value: humanize(claim.loss_type) },
              { label: 'Loss date & time', value: formatDateTime(claim.loss_date) },
              { label: 'Location', value: formatLocation(claim) },
              { label: 'Estimated loss', value: formatMoney(claim.estimated_loss) },
              { label: 'Affected property / asset', value: claim.affected_asset },
              { label: 'Description', value: claim.loss_description, wide: true },
              claim.contact_name && { label: 'Contact', value: `${claim.contact_name} · ${claim.contact_phone}` },
              claim.contact_email && { label: 'Contact email', value: claim.contact_email },
              { label: 'Opened', value: formatDateTime(claim.opened_at) },
              claim.reopen_count > 0 && { label: 'Reopened', value: `${claim.reopen_count} time(s)` },
              { label: 'Last updated', value: formatRelative(claim.updated_at) },
              claim.rejection_reason && { label: 'Rejection reason', value: claim.rejection_reason, wide: true },
              claim.closure_reason && { label: 'Closure', value: `${claim.closure_reason} · ${formatDateTime(claim.closed_at)}`, wide: true },
            ]}
          />
        </SectionCard>

        <div className="space-y-5">
          <SlaClocks clocks={detail.slaClocks} />
          <SectionCard title="Current task">
            {currentTask ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{currentTask.title}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={currentTask.status} />
                  <PriorityBadge value={currentTask.priority} />
                  {currentTask.blocking && <span className="text-xs text-muted-foreground">Blocking</span>}
                </div>
                {currentTask.due_at && (
                  <p className={`flex items-center gap-1 text-xs ${new Date(currentTask.due_at) < new Date() ? 'font-medium text-red-700' : 'text-muted-foreground'}`}>
                    {new Date(currentTask.due_at) < new Date() && <AlertTriangle className="size-3.5" />}Due {formatRelative(currentTask.due_at)}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{counts.openTasks} open task(s) · {counts.openRequests} open request(s) · {counts.pendingDocs} document(s) awaiting review</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No open tasks.</p>
            )}
          </SectionCard>

          {(can('claims.updateMeta') || can('claims.escalate') || can('claims.documentException')) && (
            <SectionCard title="Case controls">
              <div className="space-y-3">
                {can('claims.updateMeta') && (
                  <>
                    <FormField label="Priority">
                      <Select value={meta.priority} onValueChange={(priority) => setMeta((m) => ({ ...m, priority }))} options={PRIORITIES.map((p) => ({ value: p, label: humanize(p) }))} />
                    </FormField>
                    <FormField label="Due date">
                      <Input type="datetime-local" min={toDateTimeLocal(new Date())} value={meta.dueDate} onChange={(e) => setMeta((m) => ({ ...m, dueDate: e.target.value }))} />
                    </FormField>
                    <Button size="sm" variant="outline" loading={action.pending} onClick={() => action.run(async () => { await claimsService.updateMeta(claim.id, { priority: meta.priority, dueDate: meta.dueDate ? new Date(meta.dueDate).toISOString() : null }); await reload() }, { success: 'Claim updated' })}>
                      Save
                    </Button>
                  </>
                )}
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  {can('claims.escalate') && claim.escalation_level < 3 && (
                    <Button size="sm" variant="outline" onClick={() => setEscalateOpen(true)}>
                      <Flag /> Escalate
                    </Button>
                  )}
                  {can('claims.documentException') && ['DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW'].includes(claim.status) && !claim.document_exception_at && (
                    <Button size="sm" variant="outline" onClick={() => setExceptionOpen(true)}>
                      Record document exception
                    </Button>
                  )}
                </div>
                {claim.document_exception_at && (
                  <p className="text-xs text-violet-700">
                    Document exception by {claim.document_exception_by_name}: {claim.document_exception_reason}
                  </p>
                )}
              </div>
            </SectionCard>
          )}
        </div>
      </div>

      {can('claims.verifyCoverage') && (INTAKE_STAGES.includes(claim.status) || detail.coverage) && <IntakePanel detail={detail} reload={reload} />}
      <NotesPanel claimId={claim.id} />

      <ConfirmDialog
        open={escalateOpen}
        onOpenChange={setEscalateOpen}
        title={`Escalate to level ${claim.escalation_level + 1}`}
        description="Managers are notified and the claim priority is raised."
        requireReason
        confirmLabel="Escalate"
        onConfirm={async (reason) => Boolean(await action.run(async () => { await claimsService.escalate(claim.id, reason); await reload() }, { success: 'Claim escalated' }))}
      />
      <ConfirmDialog
        open={exceptionOpen}
        onOpenChange={setExceptionOpen}
        title="Record document exception"
        description="Waives outstanding required documents so the claim can proceed. This authorization is recorded against your name."
        requireReason
        reasonMinLength={10}
        confirmLabel="Record exception"
        onConfirm={async (reason) => Boolean(await action.run(async () => { await claimsService.documentException(claim.id, reason); await reload() }, { success: 'Document exception recorded' }))}
      />
      {claim.claim_number && <TriageAgentCard claim={claim} onApplied={reload} />}
    </div>
  )
}
