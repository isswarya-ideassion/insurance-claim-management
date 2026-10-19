import { useEffect, useState } from 'react'
import { FilePlus2, Plus, Save, Send, Trash2, Undo2 } from 'lucide-react'
import { INVESTIGATION_CHECKLIST, SETTLEMENT_RECOMMENDATIONS, humanize } from '@shared/constants.js'
import { assessmentsService } from '@/services/workflowService.js'
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

function AssessmentEditor({ assessment, onSaved, onSubmitted }) {
  const action = useAction()
  const [form, setForm] = useState(null)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [reserve, setReserve] = useState({ amount: '', reason: '' })

  useEffect(() => {
    setForm({
      checklist: assessment.checklist || {},
      findings: assessment.findings || '',
      evidence: assessment.evidence || [],
      estimatedLoss: assessment.estimated_loss ?? '',
      recommendedSettlement: assessment.recommended_settlement ?? '',
      recommendation: assessment.recommendation || '',
      internalNotes: assessment.internal_notes || '',
    })
  }, [assessment])

  if (!form) return null
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const payload = () => ({
    checklist: form.checklist,
    findings: form.findings || null,
    evidence: form.evidence.filter((e) => e.description?.trim().length >= 2),
    estimatedLoss: form.estimatedLoss === '' ? null : Number(form.estimatedLoss),
    recommendedSettlement: form.recommendedSettlement === '' ? null : Number(form.recommendedSettlement),
    recommendation: form.recommendation || null,
    internalNotes: form.internalNotes || null,
  })

  async function save(silent = false) {
    return action.run(async () => {
      const updated = await assessmentsService.update(assessment.id, payload())
      onSaved?.(updated)
      return updated
    }, { success: silent ? undefined : 'Draft saved' })
  }

  const denial = form.recommendation === 'DENY'
  return (
    <SectionCard
      title={`Assessment v${assessment.version_no} (draft)`}
      description="Complete the investigation checklist, record findings and evidence, then submit with a reserve request."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => save()} loading={action.pending}>
            <Save /> Save draft
          </Button>
          <Button size="sm" variant="accent" onClick={async () => { if (await save(true)) { setReserve({ amount: form.recommendedSettlement || '', reason: '' }); setSubmitOpen(true) } }}>
            <Send /> Submit assessment
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
          <FormField label="Assessed loss amount (USD)">
            <Input type="number" min="0" step="0.01" value={form.estimatedLoss} onChange={(e) => set('estimatedLoss', e.target.value)} />
          </FormField>
          <FormField label="Settlement recommendation">
            <Select value={form.recommendation} onValueChange={(v) => set('recommendation', v)} placeholder="Select recommendation" options={SETTLEMENT_RECOMMENDATIONS.map((r) => ({ value: r, label: humanize(r) }))} />
          </FormField>
          {!denial && (
            <FormField label="Recommended settlement (USD)" hint="After deductible and exclusions">
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
          description="Managers are notified to decide on rejecting the claim. No reserve is requested."
          confirmLabel="Submit"
          onConfirm={async () => Boolean(await action.run(async () => { const r = await assessmentsService.submit(assessment.id, {}); onSubmitted?.(r); return r }, { success: 'Assessment submitted' }))}
        />
      ) : (
        <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Submit assessment & request reserve</DialogTitle>
              <DialogDescription>The reserve must cover the recommended settlement. A claims manager within their approval limit must approve it.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm">Recommended settlement: <strong>{formatMoney(form.recommendedSettlement)}</strong></p>
              <FormField label="Reserve amount (USD)" required>
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
                  const r = await action.run(() => assessmentsService.submit(assessment.id, { reserveAmount: Number(reserve.amount), reserveReason: reserve.reason || undefined }), { success: 'Assessment submitted for reserve approval' })
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

export function InvestigationTab({ detail, reload }) {
  const { claim } = detail
  const { user, can } = useAuth()
  const query = useApiQuery(() => assessmentsService.list(claim.id), [claim.id, claim.status])
  const action = useAction()
  const [returning, setReturning] = useState(null)
  const isAssignedAdjuster = can('assessments.write') && claim.assigned_adjuster_id === user.id
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
        return (
          <div className="space-y-5">
            {isAssignedAdjuster && draft && claim.status === 'INVESTIGATION' && <AssessmentEditor assessment={draft} onSaved={() => query.reload()} onSubmitted={refresh} />}
            {canStart && (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-8 text-center">
                <p className="text-sm text-muted-foreground">{latest ? `Assessment v${latest.version_no} was ${latest.status.toLowerCase()}. Start a corrected version — previous content is carried over.` : 'Start the loss assessment for this claim.'}</p>
                <Button onClick={() => action.run(async () => { await assessmentsService.create(claim.id); await query.reload() }, { success: 'Assessment draft created' })} loading={action.pending}>
                  <FilePlus2 /> {latest ? 'Start corrected version' : 'Start assessment'}
                </Button>
              </div>
            )}
            {!isAssignedAdjuster && claim.status === 'INVESTIGATION' && !rows.length && <EmptyState title="Investigation in progress" description={claim.assigned_adjuster_name ? `Assigned to ${claim.assigned_adjuster_name}.` : 'No adjuster assigned yet.'} />}

            {rows.filter((a) => a.status !== 'DRAFT' || !isAssignedAdjuster).map((a) => (
              <SectionCard
                key={a.id}
                title={`Assessment v${a.version_no}`}
                description={`${a.adjuster_name}${a.submitted_at ? ` · submitted ${formatDateTime(a.submitted_at)}` : ''}`}
                actions={
                  <>
                    <StatusBadge value={a.status} />
                    {can('assessments.return') && ['SUBMITTED', 'APPROVED'].includes(a.status) && ['RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL'].includes(claim.status) && a.adjuster_id !== user.id && (
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
                    { label: 'Assessed loss', value: formatMoney(a.estimated_loss) },
                    { label: 'Recommendation', value: humanize(a.recommendation) },
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
              title={`Return assessment v${returning?.version_no} for correction`}
              description="The claim returns to investigation, any pending reserve is returned, and the adjuster receives a correction task. History is preserved."
              requireReason
              reasonLabel="What needs correcting"
              confirmLabel="Return assessment"
              onConfirm={async (comment) => Boolean(await action.run(async () => { await assessmentsService.returnForCorrection(returning.id, comment); await refresh() }, { success: 'Assessment returned' }))}
            />
          </div>
        )
      }}
    </QueryState>
  )
}
