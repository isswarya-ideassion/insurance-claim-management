import { useEffect, useState } from 'react'
import { ClipboardList, FilePlus2, Plus, Save, Send, Trash2, Undo2 } from 'lucide-react'
import { INVESTIGATION_CHECKLIST, EVALUATION_DECISIONS, STATUS_LABELS, humanize } from '@shared/constants.js'
import { toast } from 'sonner'
import { evaluationsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField, KeyValue, SectionCard } from '@/components/common/FormField.js'
import { QueryState, EmptyState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Checkbox } from '@/components/ui/misc.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime, formatMoney } from '@/utils/format.js'

function EvaluationEditor({ evaluation, onSaved, onSubmitted }) {
  const action = useAction()
  const [form, setForm] = useState(null)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [reserve, setReserve] = useState({ amount: '', reason: '' })

  useEffect(() => {
    setForm({
      checklist: evaluation.checklist || {},
      findings: evaluation.findings || '',
      evidence: evaluation.evidence || [],
      lossValue: evaluation.loss_value ?? '',
      liabilityPct: evaluation.liability_pct ?? '',
      recommendedSettlement: evaluation.recommended_settlement ?? '',
      decision: evaluation.decision || '',
      internalNotes: evaluation.internal_notes || '',
    })
  }, [evaluation])

  if (!form) return null
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const payload = () => ({
    checklist: form.checklist,
    findings: form.findings || null,
    evidence: form.evidence.filter((e) => e.description?.trim().length >= 2),
    lossValue: form.lossValue === '' ? null : Number(form.lossValue),
    liabilityPct: form.liabilityPct === '' ? null : Number(form.liabilityPct),
    recommendedSettlement: form.recommendedSettlement === '' ? null : Number(form.recommendedSettlement),
    decision: form.decision || null,
    internalNotes: form.internalNotes || null,
  })

  async function save(silent = false) {
    return action.run(async () => {
      const updated = await evaluationsService.update(evaluation.id, payload())
      onSaved?.(updated)
      return updated
    }, { success: silent ? undefined : 'Draft saved' })
  }

  const denial = form.decision === 'DENY'
  return (
    <SectionCard
      title={`Evaluation v${evaluation.version_no} (draft)`}
      description="Complete the investigation checklist, record findings and evidence, then submit with a reserve request."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => save()} loading={action.pending}>
            <Save /> Save draft
          </Button>
          <Button size="sm" variant="accent" onClick={async () => { if (await save(true)) { setReserve({ amount: form.recommendedSettlement || '', reason: '' }); setSubmitOpen(true) } }}>
            <Send /> Submit evaluation
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium">Investigation checklist</p>
            <ul className="mt-2 space-y-2">
              {INVESTIGATION_CHECKLIST.map((item) => (
                <li key={item.key} className="flex items-start gap-2.5">
                  <Checkbox id={`inv-${item.key}`} checked={Boolean(form.checklist[item.key])} onCheckedChange={(v) => set('checklist', { ...form.checklist, [item.key]: v === true })} className="mt-0.5" />
                  <label htmlFor={`inv-${item.key}`} className="text-sm">{item.label}</label>
                </li>
              ))}
            </ul>
          </div>
          <FormField label="Findings" hint="At least 20 characters">
            <Textarea value={form.findings} onChange={(e) => set('findings', e.target.value)} className="min-h-32" />
          </FormField>
          <div>
            <p className="text-sm font-medium">Evidence</p>
            <ul className="mt-2 space-y-2">
              {form.evidence.map((ev, i) => (
                <li key={i} className="flex gap-2">
                  <Input value={ev.description} onChange={(e) => set('evidence', form.evidence.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label={`Evidence ${i + 1}`} />
                  <Button size="icon" variant="ghost" onClick={() => set('evidence', form.evidence.filter((_, j) => j !== i))} aria-label="Remove evidence">
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => set('evidence', [...form.evidence, { description: '' }])}>
              <Plus /> Add evidence item
            </Button>
          </div>
        </div>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Loss value (₹)">
              <Input type="number" min="0" step="0.01" value={form.lossValue} onChange={(e) => set('lossValue', e.target.value)} />
            </FormField>
            <FormField label="Liability (%)">
              <Input type="number" min="0" max="100" step="1" value={form.liabilityPct} onChange={(e) => set('liabilityPct', e.target.value)} />
            </FormField>
          </div>
          <FormField label="Decision">
            <Select value={form.decision} onValueChange={(v) => set('decision', v)} placeholder="Select decision" options={EVALUATION_DECISIONS.map((r) => ({ value: r, label: humanize(r) }))} />
          </FormField>
          {!denial && (
            <FormField label="Recommended settlement (₹)" hint="After deductible and exclusions">
              <Input type="number" min="0" step="0.01" value={form.recommendedSettlement} onChange={(e) => set('recommendedSettlement', e.target.value)} />
            </FormField>
          )}
          <FormField label="Internal notes" hint="Never shown to the claimant">
            <Textarea value={form.internalNotes} onChange={(e) => set('internalNotes', e.target.value)} />
          </FormField>
        </div>
      </div>

      {denial ? (
        <ConfirmDialog
          open={submitOpen}
          onOpenChange={setSubmitOpen}
          title="Submit denial recommendation"
          description="The Claims Manager is notified to decide on denying the claim. No reserve is set."
          confirmLabel="Submit"
          onConfirm={async () => Boolean(await action.run(async () => { const r = await evaluationsService.submit(evaluation.id, {}); onSubmitted?.(r); return r }, { success: 'Evaluation submitted' }))}
        />
      ) : (
        <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit evaluation & set reserve</DialogTitle>
              <DialogDescription>The reserve must cover the recommended settlement. Within your reserve authority it posts immediately; above it, a Claims Manager reviews it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm">Recommended settlement: <strong>{formatMoney(form.recommendedSettlement)}</strong></p>
              <FormField label="Reserve amount (₹)" required>
                <Input type="number" min="0" step="0.01" value={reserve.amount} onChange={(e) => setReserve((r) => ({ ...r, amount: e.target.value }))} />
              </FormField>
              <FormField label="Reserve justification">
                <Textarea value={reserve.reason} onChange={(e) => setReserve((r) => ({ ...r, reason: e.target.value }))} />
              </FormField>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSubmitOpen(false)}>Cancel</Button>
              <Button
                variant="accent"
                loading={action.pending}
                disabled={!(Number(reserve.amount) > 0)}
                onClick={async () => {
                  const r = await action.run(() => evaluationsService.submit(evaluation.id, { reserveAmount: Number(reserve.amount), reserveReason: reserve.reason || undefined }))
                  if (r) toast.success(r.reserve?.approval_status === 'POSTED' ? 'Evaluation submitted; reserve posted within your authority' : 'Evaluation submitted; reserve sent for manager review')
                  if (r) {
                    setSubmitOpen(false)
                    onSubmitted?.(r)
                  }
                }}
              >
                Submit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </SectionCard>
  )
}

const BEFORE_EVALUATION = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT']

/**
 * What the tab says when it has no editor or evaluation cards to explain the
 * claim's position, or null when the evaluation content speaks for itself.
 */
export function evaluationNotice({ claim, rows, isAssignedAdjuster }) {
  const label = STATUS_LABELS[claim.status] || humanize(claim.status)
  const adjuster = claim.assigned_adjuster_name
  const draft = rows.find((a) => a.status === 'DRAFT')

  if (claim.status === 'INVESTIGATION') {
    if (rows.length || isAssignedAdjuster) return null
    return {
      title: 'Evaluation not started',
      description: adjuster ? `${adjuster} is investigating this claim and has not saved an evaluation yet.` : 'No adjuster is assigned yet. A Claims Manager assigns one.',
    }
  }
  if (rows.length) {
    if (!draft || !isAssignedAdjuster) return null
    return {
      title: `Draft v${draft.version_no} saved`,
      description: `The claim is in ${label}. You can continue the draft when it returns to Investigation.`,
    }
  }
  if (BEFORE_EVALUATION.includes(claim.status)) {
    return {
      title: 'Evaluation not started yet',
      description: `The claim is in ${label}. The adjuster evaluates the loss once the claim reaches Investigation. ${adjuster ? `Assigned adjuster: ${adjuster}.` : 'No adjuster is assigned yet.'}`,
    }
  }
  if (claim.status === 'ON_HOLD') {
    const from = STATUS_LABELS[claim.hold_from_status]
    return {
      title: 'Claim on hold',
      description: `${from ? `The claim was put on hold during ${from}` : 'The claim was put on hold'} before an evaluation was started. Work resumes when the hold is released.`,
    }
  }
  if (claim.status === 'REOPENED') {
    return { title: 'Claim reopened', description: 'A Claims Manager resumes the investigation; the adjuster then starts a new evaluation.' }
  }
  if (['REJECTED', 'WITHDRAWN'].includes(claim.status)) {
    return { title: 'No evaluation recorded', description: `The claim was ${label.toLowerCase()} before it reached evaluation.` }
  }
  return { title: 'No evaluation recorded', description: `No evaluation was saved for this claim. It is currently ${label}.` }
}

export function InvestigationTab({ detail, reload }) {
  const { claim } = detail
  const { user, can } = useAuth()
  const query = useApiQuery(() => evaluationsService.list(claim.id), [claim.id, claim.status])
  const action = useAction()
  const [returning, setReturning] = useState(null)
  const isAssignedAdjuster = can('evaluations.write') && claim.assigned_adjuster_id === user.id
  const refresh = async () => {
    await query.reload()
    reload()
  }

  return (
    <QueryState query={query}>
      {(rows) => {
        const draft = rows.find((a) => a.status === 'DRAFT')
        const latest = rows[0]
        const canStart = isAssignedAdjuster && claim.status === 'INVESTIGATION' && !draft && (!latest || ['RETURNED', 'APPROVED'].includes(latest.status))
        const editing = isAssignedAdjuster && draft && claim.status === 'INVESTIGATION'
        const notice = evaluationNotice({ claim, rows, isAssignedAdjuster })
        return (
          <div className="space-y-5">
            {notice && <EmptyState icon={ClipboardList} title={notice.title} description={notice.description} className={rows.length ? 'py-8' : undefined} />}
            {editing && <EvaluationEditor evaluation={draft} onSaved={() => query.reload()} onSubmitted={refresh} />}
            {canStart && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-8 text-center">
                <p className="text-sm text-muted-foreground">{latest ? `Evaluation v${latest.version_no} was ${latest.status.toLowerCase()}. Start a corrected version — previous content is carried over.` : 'Start the loss evaluation for this claim.'}</p>
                <Button onClick={() => action.run(async () => { await evaluationsService.create(claim.id); await query.reload() }, { success: 'Evaluation draft created' })} loading={action.pending}>
                  <FilePlus2 /> {latest ? 'Start corrected version' : 'Start evaluation'}
                </Button>
              </div>
            )}
            {rows.filter((a) => !editing || a.id !== draft.id).map((a) => (
              <SectionCard
                key={a.id}
                title={`Evaluation v${a.version_no}`}
                description={`${a.adjuster_name}${a.submitted_at ? ` · submitted ${formatDateTime(a.submitted_at)}` : ''}`}
                actions={
                  <>
                    <StatusBadge value={a.status} />
                    {can('evaluations.return') && ['SUBMITTED', 'APPROVED'].includes(a.status) && ['RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL'].includes(claim.status) && a.adjuster_id !== user.id && (
                      <Button size="sm" variant="outline" onClick={() => setReturning(a)}>
                        <Undo2 /> Return for correction
                      </Button>
                    )}
                  </>
                }
              >
                <KeyValue
                  columns={3}
                  items={[
                    { label: 'Loss value', value: formatMoney(a.loss_value) },
                    { label: 'Decision', value: humanize(a.decision) },
                    a.liability_pct != null && { label: 'Liability', value: `${Number(a.liability_pct)}%` },
                    { label: 'Recommended settlement', value: formatMoney(a.recommended_settlement) },
                    { label: 'Findings', value: <span className="whitespace-pre-line">{a.findings}</span>, wide: true },
                    a.evidence?.length > 0 && { label: 'Evidence', value: <ul className="list-disc pl-5">{a.evidence.map((e, i) => <li key={i}>{e.description}</li>)}</ul>, wide: true },
                    a.internal_notes && { label: 'Internal notes', value: a.internal_notes, wide: true },
                    { label: 'Checklist', value: `${INVESTIGATION_CHECKLIST.filter((i) => a.checklist?.[i.key]).length}/${INVESTIGATION_CHECKLIST.length} complete` },
                    a.reviewed_by_name && { label: 'Reviewed by', value: `${a.reviewed_by_name} · ${formatDateTime(a.reviewed_at)}` },
                    a.review_comment && { label: 'Review comment', value: a.review_comment, wide: true },
                  ]}
                />
              </SectionCard>
            ))}

            <ConfirmDialog
              open={Boolean(returning)}
              onOpenChange={(o) => !o && setReturning(null)}
              title={`Return evaluation v${returning?.version_no} for correction`}
              description="The claim returns to evaluation, any reserve awaiting review is returned, and the adjuster receives a correction task. History is preserved."
              requireReason
              reasonLabel="What needs correcting"
              confirmLabel="Return evaluation"
              onConfirm={async (comment) => Boolean(await action.run(async () => { await evaluationsService.returnForCorrection(returning.id, comment); await refresh() }, { success: 'Evaluation returned' }))}
            />
          </div>
        )
      }}
    </QueryState>
  )
}
