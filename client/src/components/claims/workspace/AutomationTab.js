import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Clock, FileSearch, Sparkles, XCircle } from 'lucide-react'
import { humanize, STATUS_LABELS, EXTRACTION_EDITABLE_STATUSES } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { documentsService } from '@/services/documentsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { SectionCard, KeyValue } from '@/components/common/FormField.js'
import { QueryState, TableSkeleton, EmptyState } from '@/components/common/States.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Checkbox } from '@/components/ui/misc.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js'
import {
  AiBadge,
  AiErrorNotice,
  AiSetupNotice,
  ReminderDraftDialog,
  ReminderStatusBadge,
  ReminderTypeLabel,
  RuleBadge,
} from '@/components/automation/AutomationComponents.js'
import { RunImageForensicsAlert } from '@/components/automation/ImageForensicsAlert.js'
import { RescanButton, ScanningSkeleton } from '@/components/automation/DocumentAiScan.js'
import { UnnecessaryDocumentNotice, isIrrelevant } from '@/components/automation/UnnecessaryDocumentNotice.js'
import { formatDate, formatDateTime, formatMoney, formatRelative } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

const STATE_STYLE = {
  ACCEPTED: { icon: CheckCircle2, tone: 'green', label: 'Accepted' },
  PENDING_REVIEW: { icon: Clock, tone: 'amber', label: 'Awaiting review' },
  REJECTED: { icon: XCircle, tone: 'red', label: 'Rejected — replacement needed' },
  MISSING: { icon: CircleDashed, tone: 'red', label: 'Not received' },
}

/** Runs an AI call and keeps its error inline (with retry) rather than in a toast. */
function useAiCall() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  async function run(fn) {
    setPending(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(err)
      return undefined
    } finally {
      setPending(false)
    }
  }
  return { pending, error, run, clear: () => setError(null) }
}

// ---------------------------------------------------------------------------
// B. Missing documents
// ---------------------------------------------------------------------------
function DocumentChecklistCard({ claim, onChanged }) {
  const { can } = useAuth()
  const query = useApiQuery(() => automationService.documentChecklist(claim.id), [claim.id, claim.updated_at])
  const action = useAction()
  const [review, setReview] = useState(null)
  const canRemind = can('automation.reminders')

  async function prepare() {
    const draft = await action.run(() => automationService.createReminderDraft(claim.id), { success: 'Reminder draft prepared — review it before sending' })
    if (draft) {
      await query.reload()
      setReview({ ...draft, claim_number: claim.claim_number, recipient_name: claim.customer_name, created_by_name: 'you' })
    }
  }

  return (
    <SectionCard
      title="Missing documents"
      description="Received documents compared with the required checklist for this claim type."
      actions={<RuleBadge />}
    >
      <QueryState query={query} skeleton={<TableSkeleton rows={3} cols={3} />}>
        {(c) => (
          <div className="space-y-4">
            {c.documentException && (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm">Document exception recorded {formatDate(c.documentException.at)}: {c.documentException.reason}</p>
            )}
            {c.required.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents are required for this claim type.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {c.required.map((item) => {
                  const style = STATE_STYLE[item.state]
                  const Icon = style.icon
                  return (
                    <li key={item.category} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
                      <div className="flex min-w-0 items-start gap-2">
                        <Icon className={cn('mt-0.5 size-4 shrink-0', item.state === 'ACCEPTED' ? 'text-emerald-600' : item.state === 'PENDING_REVIEW' ? 'text-amber-600' : 'text-red-600')} aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{item.label}</p>
                          {item.rejectionReason && <p className="text-xs text-red-700">Rejected: {item.rejectionReason}</p>}
                          {item.documents[0] && <p className="truncate text-xs text-muted-foreground">{item.documents[0].file_name}</p>}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={style.tone}>{style.label}</Badge>
                        {item.openRequest && (
                          <Badge tone={item.openRequest.overdue ? 'red' : 'navy'}>
                            Requested · due {formatDate(item.openRequest.due_at)}{item.openRequest.overdue ? ' (overdue)' : ''}
                          </Badge>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {c.additional.length > 0 && (
              <p className="text-xs text-muted-foreground">Also on file: {c.additional.map((d) => d.label).join(', ')}</p>
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested next action</p>
              <ul className="mt-1.5 space-y-1">
                {c.suggestedActions.map((a) => (
                  <li key={a.code} className="text-sm">• {a.message}</li>
                ))}
              </ul>
            </div>
            {c.openDraft ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm">
                <span>A customer reminder draft is waiting for approval.</span>
                {canRemind && (
                  <Button size="sm" variant="outline" onClick={() => setReview({ ...c.openDraft, claim_number: claim.claim_number, recipient_name: claim.customer_name, created_by_name: c.openDraft.created_by ? 'a colleague' : 'Automatic' })}>
                    Review draft
                  </Button>
                )}
              </div>
            ) : (
              canRemind && c.requestable.length > 0 && (
                <Button size="sm" onClick={prepare} loading={action.pending}>
                  Prepare reminder draft
                </Button>
              )
            )}
          </div>
        )}
      </QueryState>
      <ReminderDraftDialog
        reminder={review}
        onClose={() => setReview(null)}
        onDone={async () => {
          await query.reload()
          onChanged()
        }}
      />
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// C. Summary — recorded facts and AI suggestions, visually separate
// ---------------------------------------------------------------------------
function FactsPanel({ facts }) {
  const { loss, timeline, documentsReceived, missingInformation, pendingActions } = facts
  return (
    <div className="space-y-4">
      <KeyValue
        items={[
          { label: 'Loss', value: loss.occurred_at ? `${formatDateTime(loss.occurred_at)} · ${humanize(loss.type || '')}` : '—' },
          { label: 'Location', value: loss.location },
          { label: 'Estimated loss', value: formatMoney(loss.estimated_loss) },
          { label: 'Affected asset', value: loss.affected_asset },
          { label: 'Description', value: loss.description, wide: true },
        ]}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</p>
          <ol className="mt-1.5 space-y-1 text-sm">
            {timeline.map((t, i) => (
              <li key={i}>
                <span className="text-muted-foreground">{formatDate(t.at)}</span> · {STATUS_LABELS[t.to] || humanize(t.to)}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Documents received</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {documentsReceived.length === 0 && <li className="text-muted-foreground">None</li>}
            {documentsReceived.map((d, i) => (
              <li key={i}>{humanize(d.doc_type)} <span className="text-muted-foreground">· {humanize(d.status).toLowerCase()}</span></li>
            ))}
          </ul>
          {missingInformation.length > 0 && (
            <p className="mt-2 text-sm text-red-700">Missing: {missingInformation.map((m) => humanize(m.doc_type)).join(', ')}</p>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pending actions</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {pendingActions.length === 0 && <li className="text-muted-foreground">None</li>}
            {pendingActions.map((p, i) => (
              <li key={i} className={p.overdue ? 'text-red-700' : ''}>
                {p.description}
                {p.due_at && <span className="text-muted-foreground"> · due {formatRelative(p.due_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ claim, aiStatus }) {
  const { can } = useAuth()
  const query = useApiQuery(() => automationService.summary(claim.id), [claim.id, claim.updated_at])
  const ai = useAiCall()
  const canGenerate = can('automation.summarize') && aiStatus?.configured

  async function generate() {
    const result = await ai.run(() => automationService.generateSummary(claim.id))
    if (result) query.setData((d) => ({ ...d, facts: result.facts, ai: result.ai }))
  }

  return (
    <SectionCard title="Claim summary" description="Recorded facts come straight from the claim record. AI suggestions are shown separately.">
      <QueryState query={query} skeleton={<TableSkeleton rows={4} cols={3} />}>
        {(s) => (
          <div className="space-y-5">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold">Recorded facts</h3>
                <RuleBadge />
              </div>
              <FactsPanel facts={s.facts} />
            </div>
            <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">AI suggestions</h3>
                  {s.ai && <AiBadge />}
                </div>
                {can('automation.summarize') && (
                  <Button size="sm" variant="outline" onClick={generate} loading={ai.pending} disabled={!canGenerate}>
                    <Sparkles /> {s.ai ? 'Regenerate' : 'Generate summary'}
                  </Button>
                )}
              </div>
              {ai.pending && <p className="mt-3 text-sm text-muted-foreground">Summarizing the recorded facts… this can take up to a minute.</p>}
              <div className="mt-3">
                <AiErrorNotice error={ai.error} onRetry={generate} />
              </div>
              {!aiStatus?.configured && !s.ai && <p className="mt-2 text-sm text-muted-foreground">AI summaries are unavailable until an AI provider is configured.</p>}
              {s.ai && (
                <div className="mt-3 space-y-3 text-sm">
                  {s.ai.stale && <p className="text-xs text-amber-800">The claim changed after this summary was generated. Regenerate it before relying on it.</p>}
                  <p className="whitespace-pre-line">{s.ai.summary}</p>
                  {s.ai.suggestedNextActions?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suggested next steps</p>
                      <ul className="mt-1 space-y-1">
                        {s.ai.suggestedNextActions.map((a, i) => (
                          <li key={i}>• {a.action} <span className="text-muted-foreground">— {a.reason}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {s.ai.pointsToVerify?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Points to verify</p>
                      <ul className="mt-1 space-y-1">
                        {s.ai.pointsToVerify.map((p, i) => (
                          <li key={i}>• {p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {s.ai.removedSuggestions > 0 && (
                    <p className="text-xs text-muted-foreground">{s.ai.removedSuggestions} suggestion(s) were withheld because they proposed a final claim decision.</p>
                  )}
                  <p className="text-xs text-muted-foreground">Generated {formatDateTime(s.ai.generatedAt)} · {s.ai.model}. {s.disclaimer}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </QueryState>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// A. Document extraction with review and confirmation
// ---------------------------------------------------------------------------
function displayValue(field, value) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>
  if (field.key === 'loss_date') return formatDateTime(value)
  if (field.key === 'estimated_loss') return formatMoney(value)
  return String(value)
}

/** One extraction run. The document's name is on the section around it. `imageAlertPinned`: an accepted alert is already shown above. */
function ExtractionReview({ run, claim, imageAlertPinned = false, documentStatus, onRejected, onChanged }) {
  // A non-image file's relevance comes from its own text; an image's notice is part of its forensics banner.
  const unrelatedFile = isIrrelevant(run.result?.relevance) && !(run.result?.imageFraudAlerts || []).some(isIrrelevant)
  const { can } = useAuth()
  const fields = run.result?.fields || []
  const applicable = fields.filter((f) => f.applicable)
  const [selected, setSelected] = useState([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const action = useAction()
  const pending = run.review_status === 'PENDING_REVIEW'
  const editable = EXTRACTION_EDITABLE_STATUSES.includes(claim.status)
  const canApply = can('automation.applyExtraction') && pending && editable
  // A run that read no value at all collapses its comparison table to one line.
  const hasValues = fields.some((f) => f.value !== null && f.value !== undefined && f.value !== '')
  const [showTable, setShowTable] = useState(false)

  const toggle = (key) => setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))

  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Extracted fields</span>
          {run.result?.document?.version != null && <span className="text-muted-foreground">· v{run.result.document.version}</span>}
          {run.result?.documentType && <span className="text-muted-foreground">· {run.result.documentType}</span>}
          <AiBadge />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {run.review_status === 'APPLIED' && (run.applied_fields || []).some((f) => f !== 'image_fraud_alert') && (
            <Badge tone="green">Applied: {run.applied_fields.filter((f) => f !== 'image_fraud_alert').length} field(s)</Badge>
          )}
          {(run.applied_fields || []).includes('image_fraud_alert') && <Badge tone="red">Image alert accepted</Badge>}
          {run.review_status === 'DISCARDED' && <Badge tone="neutral">Discarded</Badge>}
          {pending && <Badge tone="amber">Awaiting review</Badge>}
          <span>{formatDateTime(run.created_at)}</span>
        </div>
      </div>
      {!imageAlertPinned && (
        <RunImageForensicsAlert run={run} className="m-3" onAccepted={() => onChanged()} documentStatus={documentStatus} onRejected={onRejected} />
      )}
      {unrelatedFile && (
        <UnnecessaryDocumentNotice
          className="m-3"
          documentId={run.document_id}
          detail={run.result.relevance.detail}
          documentStatus={documentStatus}
          onRejected={onRejected}
        />
      )}
      {!hasValues && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="text-muted-foreground">No structured fields extracted from document</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
            {showTable ? <ChevronUp /> : <ChevronDown />} {showTable ? 'Hide claim fields' : 'Show claim fields'}
          </Button>
        </div>
      )}
      {(hasValues || showTable) && (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {canApply && <TableHead className="w-10"><span className="sr-only">Select</span></TableHead>}
              <TableHead>Field</TableHead>
              <TableHead>Extracted value</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>On the claim now</TableHead>
              <TableHead>Check</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((f) => (
              <TableRow key={f.key}>
                {canApply && (
                  <TableCell>
                    {f.applicable && <Checkbox checked={selected.includes(f.key)} onCheckedChange={() => toggle(f.key)} aria-label={`Apply ${f.label}`} />}
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  {f.label}
                  {!f.claimField && <span className="block text-[11px] font-normal text-muted-foreground">Reference only</span>}
                </TableCell>
                <TableCell className="max-w-xs whitespace-pre-wrap break-words">
                  {displayValue(f, f.value)}
                  {f.value !== null && <span className="block text-[11px] text-muted-foreground">Confidence: {Math.round(f.confidence * 100)}% ({humanize(f.confidence_band)}){f.needs_confirmation && " · confirm before applying"}</span>}
                </TableCell>
                <TableCell className="max-w-xs text-xs text-muted-foreground">
                  {f.source?.page && <span className="block">Page {f.source.page}</span>}
                  {f.source?.quote && <q className="break-words">{f.source.quote}</q>}
                </TableCell>
                <TableCell className="max-w-xs break-words text-sm">{displayValue(f, f.currentValue)}</TableCell>
                <TableCell className="text-xs">
                  {f.issue ? (
                    <span className="inline-flex items-start gap-1 text-red-700"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{f.issue}</span>
                  ) : f.value === null ? (
                    <span className="text-muted-foreground">Not in document</span>
                  ) : f.matchesCurrent ? (
                    <span className="text-emerald-700">Matches</span>
                  ) : f.claimField ? (
                    <span className="text-amber-800">Differs from claim</span>
                  ) : (
                    <span className="text-emerald-700">Consistent</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      )}
      {run.result?.notes?.length > 0 && (
        <div className="border-t px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">AI notes</p>
          <ul className="mt-1 space-y-0.5">{run.result.notes.map((n, i) => <li key={i}>• {n}</li>)}</ul>
        </div>
      )}
      {pending && can('automation.applyExtraction') && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {editable
              ? applicable.length
                ? 'Select the values you have checked against the document. Only selected values are saved to the claim.'
                : 'No extracted value differs from the claim and passes validation.'
              : `Claim details can no longer be changed at the ${STATUS_LABELS[claim.status] || claim.status} stage.`}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" loading={action.pending} onClick={() => action.run(async () => { await automationService.discardExtraction(run.id); onChanged() }, { success: 'Extraction discarded' })}>
              Discard
            </Button>
            {canApply && (
              <Button size="sm" disabled={selected.length === 0} onClick={() => setConfirmOpen(true)}>
                Apply {selected.length || ''} selected
              </Button>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Save extracted values to the claim?"
        description={`You confirm you checked these values against the document: ${fields.filter((f) => selected.includes(f.key)).map((f) => f.label).join(', ')}. The change is recorded in the audit log under your name.`}
        confirmLabel="Save to claim"
        onConfirm={async () =>
          Boolean(
            await action.run(async () => {
              await automationService.applyExtraction(run.id, selected)
              setSelected([])
              onChanged(true)
              return true
            }, { success: 'Claim updated from the confirmed values' }),
          )
        }
      />
    </div>
  )
}

const INTAKE_PARSER = 'intake-parser'
const hasAcceptedAlert = (run) => (run.applied_fields || []).includes('image_fraud_alert')

/** Whether a run read the document's current version (a failed run has no output, so its time decides). */
function isCurrentVersion(run, doc) {
  const version = run.result?.document?.version
  if (version != null) return version === doc.version
  return new Date(run.created_at) >= new Date(doc.received_at)
}

/**
 * One section per document. The newest successful run on the current version
 * is the active card; an accepted image alert stays pinned above it; every
 * other run folds into "Show previous runs". Runs arrive newest first.
 */
function groupRunsByDocument(docs, runs) {
  return docs.map((doc) => {
    const own = runs.filter((r) => r.document_id === doc.id)
    const extractions = own.filter((r) => r.agent === INTAKE_PARSER)
    const current = extractions.filter((r) => isCurrentVersion(r, doc))
    const latest = current.find((r) => r.status === 'SUCCEEDED') || null
    const failed = current[0]?.status === 'FAILED' ? current[0] : null
    const accepted = own.find(hasAcceptedAlert) || null
    const pinned = accepted && accepted.id !== latest?.id ? accepted : null
    const shown = new Set([latest?.id, pinned?.id, failed?.id].filter(Boolean))
    return { doc, latest, failed, pinned, previous: extractions.filter((r) => !shown.has(r.id)), scanned: current.length > 0 }
  })
}

/** What a reviewer sees of a document's latest scan, minus anything that names the document itself. */
function scanSignature(group) {
  const run = group.latest
  if (!run) return null
  return JSON.stringify({
    fields: (run.result?.fields || []).map((f) => [f.key, f.value ?? null]),
    relevance: run.result?.relevance?.status ?? null,
    alerts: (run.result?.imageFraudAlerts || []).map((a) => [a.relevance ?? null, a.riskLevel, a.checks.map((c) => c.check).sort()]),
    review: run.review_status,
    pinned: Boolean(group.pinned),
    failed: Boolean(group.failed),
  })
}

/**
 * The same file (same SHA-256) filed in several slots on this claim, with the
 * same scan result, is shown as one card; the other filings fold inside it.
 * Documents that are not scanned yet, or whose results differ, stay separate.
 */
function mergeIdenticalFiles(groups) {
  const merged = []
  const byKey = new Map()
  for (const g of groups) {
    const signature = g.doc.sha256 ? scanSignature(g) : null
    const key = signature && `${g.doc.sha256}|${signature}`
    if (key && byKey.has(key)) {
      byKey.get(key).copies.push(g)
      continue
    }
    const entry = { ...g, copies: [] }
    if (key) byKey.set(key, entry)
    merged.push(entry)
  }
  return merged
}

const joinAnd = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} & ${items.at(-1)}`)

function PinnedAlert({ run, onChanged }) {
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">
        Image alert accepted {run.agent === INTAKE_PARSER ? `on the scan of ${formatDateTime(run.created_at)}` : 'from Document Review'}
      </p>
      <RunImageForensicsAlert run={run} onAccepted={() => onChanged()} />
    </div>
  )
}

function DocumentExtractionSection({ group, claim, scanning, canRescan, manualOnly, onRescan, onChanged, onDocumentRejected, renderCopy }) {
  const { doc, latest, failed, pinned, previous, scanned, copies = [] } = group
  const [showPrevious, setShowPrevious] = useState(false)
  const [showCopies, setShowCopies] = useState(false)
  const reviewProps = { claim, documentStatus: doc.status, onRejected: onDocumentRejected, onChanged }
  const filings = [group, ...copies]
  const title = copies.length
    ? `${joinAnd([...new Set(filings.map((g) => g.doc.file_name))])} — ${joinAnd(filings.map((g) => humanize(g.doc.doc_type)))}`
    : doc.file_name
  return (
    <section className="rounded-xl border" aria-label={`Extraction for ${title}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={title}>{title}</p>
            <p className="text-xs text-muted-foreground">
              {copies.length
                ? `Same file filed ${filings.length} times · ${filings.map((g) => `${humanize(g.doc.doc_type)} v${g.doc.version} ${humanize(g.doc.status).toLowerCase()}`).join(' · ')}`
                : `${humanize(doc.doc_type)} · v${doc.version} · ${humanize(doc.status).toLowerCase()}`}
            </p>
          </div>
        </div>
        {canRescan && scanned && !scanning && <RescanButton onClick={onRescan} />}
      </div>
      <div className="space-y-3 p-3">
        {pinned && <PinnedAlert run={pinned} onChanged={onChanged} />}
        {scanning ? (
          <ScanningSkeleton />
        ) : (
          <>
            {failed && (
              <p className="flex items-start gap-1.5 text-sm text-red-700">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                The latest scan ({formatDateTime(failed.created_at)}) could not read this document.{canRescan ? ' Re-scan to try again.' : ''}
              </p>
            )}
            {latest && <ExtractionReview run={latest} imageAlertPinned={Boolean(pinned)} {...reviewProps} />}
            {!scanned &&
              (manualOnly && canRescan ? (
                <Button size="sm" variant="outline" onClick={onRescan}>
                  <Sparkles /> Extract fields
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Not scanned yet.</p>
              ))}
          </>
        )}
      </div>
      {copies.length > 0 && (
        <div className="border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">
            The other {copies.length === 1 ? 'filing has' : `${copies.length} filings have`} the identical file and scan result. Actions above apply to {humanize(doc.doc_type)} only.
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs text-muted-foreground" aria-expanded={showCopies} onClick={() => setShowCopies((v) => !v)}>
            {showCopies ? <ChevronUp /> : <ChevronDown />} {showCopies ? 'Hide' : 'Show'} {joinAnd(copies.map((g) => humanize(g.doc.doc_type)))}
          </Button>
          {showCopies && <div className="mt-2 space-y-3">{copies.map((g) => renderCopy(g))}</div>}
        </div>
      )}
      {previous.length > 0 && (
        <div className="border-t px-3 py-2">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" aria-expanded={showPrevious} onClick={() => setShowPrevious((v) => !v)}>
            {showPrevious ? <ChevronUp /> : <ChevronDown />} {showPrevious ? 'Hide' : 'Show'} previous runs ({previous.length})
          </Button>
          {showPrevious && (
            <div className="mt-2 space-y-3">
              {previous.map((run) =>
                run.status === 'SUCCEEDED' ? (
                  <ExtractionReview key={run.id} run={run} imageAlertPinned={Boolean(pinned)} {...reviewProps} />
                ) : (
                  <p key={run.id} className="text-xs text-muted-foreground">
                    {formatDateTime(run.created_at)} · scan failed, no values
                  </p>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ExtractionCard({ claim, aiStatus, reloadClaim }) {
  const { can } = useAuth()
  const docs = useApiQuery(() => documentsService.list(claim.id), [claim.id])
  const runs = useApiQuery(() => automationService.extractions(claim.id), [claim.id])
  const ai = useAiCall()
  const [scanning, setScanning] = useState([])
  const [lastDoc, setLastDoc] = useState(null)
  const attempted = useRef(new Set())
  const mounted = useRef(true)
  const canExtract = can('automation.extract') && Boolean(aiStatus?.configured)
  // Beacon is local and free, so it scans on its own; a paid model provider waits for a click.
  const autoScan = canExtract && aiStatus?.provider === 'beacon'
  const extractable = useMemo(() => (docs.data || []).filter((d) => d.status !== 'SUPERSEDED'), [docs.data])
  const groups = useMemo(() => groupRunsByDocument(extractable, runs.data || []), [extractable, runs.data])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // First-view fallback: scan, once per visit, each document whose current version has no run yet.
  // Usually the upload already did this; the server also shares any scan still in progress.
  useEffect(() => {
    if (!autoScan || !docs.data || !runs.data) return
    const todo = groups.filter((g) => !g.scanned && !attempted.current.has(`${g.doc.id}:${g.doc.version}`)).map((g) => g.doc)
    if (todo.length === 0) return
    todo.forEach((d) => attempted.current.add(`${d.id}:${d.version}`))
    setScanning((ids) => [...ids, ...todo.map((d) => d.id)])
    ;(async () => {
      for (const d of todo) {
        try {
          await automationService.ensureExtraction(d.id)
        } catch {
          // Left as "Not scanned yet"; the reviewer can still scan by hand.
        }
        if (!mounted.current) return
        setScanning((ids) => ids.filter((id) => id !== d.id))
        await runs.reload()
      }
    })()
    // runs.reload is stable; groups changes with the data it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScan, groups])

  async function extract(doc) {
    setScanning((ids) => [...ids, doc.id])
    setLastDoc(doc)
    const run = await ai.run(() => automationService.extract(doc.id))
    setScanning((ids) => ids.filter((id) => id !== doc.id))
    await runs.reload()
    if (run) ai.clear()
  }

  const onChanged = async (claimChanged) => {
    await runs.reload()
    if (claimChanged) reloadClaim()
  }

  // Display only: identical files with identical results share one card. Auto-scan still works per document.
  const shownGroups = useMemo(() => mergeIdenticalFiles(groups), [groups])
  const renderSection = (g) => (
    <DocumentExtractionSection
      key={g.doc.id}
      group={g}
      claim={claim}
      scanning={scanning.includes(g.doc.id)}
      canRescan={canExtract && scanning.length === 0}
      manualOnly={!autoScan}
      onRescan={() => extract(g.doc)}
      onChanged={onChanged}
      onDocumentRejected={() => {
        docs.reload()
        reloadClaim()
      }}
      renderCopy={renderSection}
    />
  )

  return (
    <SectionCard
      title="Document extraction"
      description={
        autoScan
          ? 'Beacon reads each document automatically when it arrives. Check the values, then confirm which to save.'
          : 'Read fields from an uploaded document, then confirm which values to save.'
      }
    >
      <div className="space-y-4">
        <AiErrorNotice error={ai.error} onRetry={lastDoc ? () => extract(lastDoc) : undefined} />
        {extractable.length === 0 && !docs.loading ? (
          <EmptyState title="No documents to read" description="Uploaded claim documents will appear here." />
        ) : (
          <QueryState query={runs} skeleton={<TableSkeleton rows={2} cols={4} />}>
            {() => (
              <div className="space-y-4">{shownGroups.map((g) => renderSection(g))}</div>
            )}
          </QueryState>
        )}
      </div>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// D. Reminder history
// ---------------------------------------------------------------------------
function ReminderHistoryCard({ claim, version }) {
  const query = useApiQuery(() => automationService.claimReminders(claim.id), [claim.id, version])
  return (
    <SectionCard title="Reminder history" description="Deadline reminders to the claim owner (automatic, sent once per deadline) and customer reminders (sent only after approval).">
      <QueryState query={query} skeleton={<TableSkeleton rows={2} cols={4} />} empty={<p className="text-sm text-muted-foreground">No reminders yet.</p>}>
        {(rows) => (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium"><ReminderTypeLabel type={r.reminder_type} /> · {r.audience === 'CUSTOMER' ? 'to claimant' : `to ${r.recipient_name}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(r.created_at)} · {r.created_by_name}
                    {r.decided_by_name && r.decided_by && ` · ${r.status === 'APPROVED' ? 'approved' : 'discarded'} by ${r.decided_by_name}`}
                  </p>
                </div>
                <ReminderStatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </SectionCard>
  )
}

export function AutomationTab({ detail, reload }) {
  const { claim } = detail
  const status = useApiQuery(() => automationService.status(), [])
  const [version, setVersion] = useState(0)
  const changed = () => {
    setVersion((v) => v + 1)
    reload()
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Automation handles repetitive administration. It never approves, rejects or settles a claim or decides on fraud — those decisions stay with authorized staff.
      </p>
      <AiSetupNotice status={status.data} />
      <div className="grid gap-5 xl:grid-cols-2">
        <DocumentChecklistCard claim={claim} onChanged={changed} />
        <ReminderHistoryCard claim={claim} version={version} />
      </div>
      <SummaryCard claim={claim} aiStatus={status.data} />
      <ExtractionCard claim={claim} aiStatus={status.data} reloadClaim={reload} />
    </div>
  )
}
