import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, Sparkles, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { CLAIM_AGENTS, humanize } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { FormField, KeyValue, SectionCard } from '@/components/common/FormField.js'
import { QueryState } from '@/components/common/States.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { AiBadge, AiErrorNotice } from '@/components/automation/AutomationComponents.js'
import { formatDate, formatDateTime, formatMoney } from '@/utils/format.js'

const REVIEW = {
  PENDING_REVIEW: { tone: 'amber', icon: Clock, label: 'Awaiting review' },
  APPLIED: { tone: 'green', icon: CheckCircle2, label: 'Applied' },
  DISCARDED: { tone: 'neutral', icon: XCircle, label: 'Discarded' },
}

function ReviewBadge({ status }) {
  const s = REVIEW[status]
  if (!s) return null
  return (
    <Badge tone={s.tone}>
      <s.icon className="size-3" aria-hidden="true" /> {s.label}
    </Badge>
  )
}

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const List = ({ items, empty = 'None' }) => (items?.length ? <ul className="list-disc space-y-0.5 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="text-muted-foreground">{empty}</span>)

/** Who may see an agent's card: whoever may run it or act on it, plus Claims Managers and Compliance & Security. */
export function useAgentAccess(agent) {
  const { can, hasRole } = useAuth()
  const def = CLAIM_AGENTS[agent]
  const canRun = can(def.run)
  const canView = canRun || can(def.apply) || hasRole('OPS_MANAGER', 'COMPLIANCE_SECURITY') || (agent === 'triage-router' && can('compliance.review'))
  return { canRun, canView }
}

/**
 * Shared frame for every claim agent: run, latest result, apply or discard.
 * `renderResult(run)` shows the suggestion; `renderApply({ run, apply, pending })` the form that acts on it.
 */
export function AgentCard(props) {
  const { canRun, canView } = useAgentAccess(props.agent)
  return canView ? <AgentCardBody {...props} canRun={canRun} /> : null
}

function AgentCardBody({ claim, agent, description, renderResult, renderApply, onApplied, canRun }) {
  const query = useApiQuery(() => automationService.agentRuns(claim.id, agent), [claim.id, agent])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)

  async function act(fn, success) {
    setPending(true)
    setError(null)
    try {
      const result = await fn()
      if (success) toast.success(success)
      await query.reload()
      return result
    } catch (err) {
      setError(err)
      return undefined
    } finally {
      setPending(false)
    }
  }
  const run = () => act(() => automationService.runAgent(claim.id, agent))

  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-2">
          {CLAIM_AGENTS[agent].label} <AiBadge />
        </span>
      }
      description={description}
      actions={
        canRun && (
          <Button size="sm" variant="outline" onClick={run} loading={pending} disabled={query.data && !query.data.configured}>
            <Sparkles /> {query.data?.runs?.some((r) => r.status === 'SUCCEEDED') ? 'Run again' : 'Run'}
          </Button>
        )
      }
    >
      <QueryState query={query}>
        {(data) => {
          const latest = data.runs.find((r) => r.status === 'SUCCEEDED')
          const reviewable = latest && latest.canApply && (latest.human_decision === 'PENDING' || (agent === 'triage-router' && latest.human_decision === 'ACCEPTED'))
          return (
            <div className="space-y-4 text-sm">
              {!data.configured && !latest && (
                <p className="text-muted-foreground">AI is not configured on this server. An administrator sets AI_PROVIDER=ollama (or anthropic) in server/.env.</p>
              )}
              {pending && <p className="text-muted-foreground">Asking the AI model… local models can take up to a minute.</p>}
              <AiErrorNotice error={error} onRetry={canRun ? run : undefined} />
              {!latest && data.configured && !pending && <p className="text-muted-foreground">No suggestion yet.{canRun ? ' Run the agent to get one.' : ''}</p>}
              {latest && (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <ReviewBadge status={latest.review_status} />
                    <span>{formatDateTime(latest.created_at)} · {latest.model} · confidence {pct(latest.confidence)}</span>
                    {latest.decided_by_name && <span>· reviewed by {latest.decided_by_name}</span>}
                  </div>
                  {renderResult(latest)}
                  {reviewable && renderApply && (
                    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                      {renderApply({ run: latest, pending, apply: (body, success) => act(async () => { const r = await automationService.applyAgentRun(latest.id, body); onApplied?.(); return r }, success) })}
                      {latest.human_decision === 'PENDING' && (
                        <Button size="sm" variant="ghost" onClick={() => act(() => automationService.discardAgentRun(latest.id), 'Suggestion discarded')} disabled={pending}>
                          <XCircle /> Discard suggestion
                        </Button>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{data.disclaimer}</p>
                </>
              )}
            </div>
          )
        }}
      </QueryState>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// Coverage (Policy & Coverage tab)
// ---------------------------------------------------------------------------
const RESULT_TONE = { COVERED: 'green', NOT_COVERED: 'red', NEEDS_REVIEW: 'amber' }
const clauseText = (c) => `${c.id}: ${c.text}`

function CoverageApply({ run, apply, pending, claim }) {
  const [result, setResult] = useState(run.result.result)
  const [notes, setNotes] = useState('')
  if (!['SUBMITTED', 'POLICY_VERIFICATION', 'REOPENED'].includes(claim.status)) return <p className="text-muted-foreground">Coverage can only be recorded during intake.</p>
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Coverage result to record">
          <Select value={result} onValueChange={setResult} options={['COVERED', 'NOT_COVERED', 'NEEDS_REVIEW'].map((v) => ({ value: v, label: humanize(v) }))} />
        </FormField>
        <FormField label="Notes" hint="Optional. The AI rationale is used if left empty.">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
      <Button size="sm" variant="accent" loading={pending} onClick={() => apply({ result, notes: notes || undefined }, 'Coverage recorded')}>
        <CheckCircle2 /> Record coverage result
      </Button>
    </>
  )
}

export function CoverageAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="coverage-checker"
      description="Compares the loss with the policy wording and cites clauses. A claims officer records the decision."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <div className="space-y-3">
            <Badge tone={RESULT_TONE[r.result]}>{humanize(r.result)}</Badge>
            <KeyValue
              items={[
                { label: 'Covering clauses', value: <List items={r.coveringClauses?.map(clauseText)} /> },
                { label: 'Exclusions that may apply', value: <List items={r.exclusionClauses?.map(clauseText)} /> },
                { label: 'Matched perils', value: r.matchedPerils?.join(', ') || '—' },
                { label: 'Limit · deductible', value: `${formatMoney(r.applicableLimit)} · ${formatMoney(r.deductible)}` },
                { label: 'Rationale', value: r.rationale, wide: true },
                !r.hardChecks?.passed && { label: 'Hard checks failed', value: r.hardChecks.reasons.join('; '), wide: true },
                r.checkerNotes?.length > 0 && { label: 'Checks on the AI output', value: <List items={r.checkerNotes} />, wide: true },
              ]}
            />
          </div>
        )
      }}
      renderApply={(p) => <CoverageApply {...p} claim={claim} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Triage (Overview tab)
// ---------------------------------------------------------------------------
function TriageApply({ run, apply, pending }) {
  const { can } = useAuth()
  const r = run.result
  const done = run.applied_fields || []
  const [adjusterId, setAdjusterId] = useState(r.recommendedAdjuster?.id || '')
  return (
    <div className="space-y-3">
      {can('claims.updateMeta') && !done.includes('classification') && (
        <Button size="sm" variant="outline" loading={pending} onClick={() => apply({ parts: ['classification'] }, 'Severity and complexity applied')}>
          Apply severity {humanize(r.severity)} and complexity {r.complexity}
        </Button>
      )}
      {can('claims.assignAdjuster') && !done.includes('adjuster') && r.candidates?.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Adjuster" className="w-64">
            <Select value={adjusterId} onValueChange={setAdjusterId} options={r.candidates.map((c) => ({ value: c.id, label: `${c.name} (${c.openClaims} open)${c.id === r.recommendedAdjuster?.id ? ' · suggested' : ''}` }))} />
          </FormField>
          <Button size="sm" variant="accent" disabled={!adjusterId} loading={pending} onClick={() => apply({ parts: ['adjuster'], adjusterId }, 'Adjuster assigned')}>
            Assign adjuster
          </Button>
        </div>
      )}
      {can('compliance.review') && !done.includes('fraud_flags') && r.fraudReasons?.length > 0 && (
        <Button size="sm" variant="outline" loading={pending} onClick={() => apply({ parts: ['fraud_flags'] }, 'Fraud flags recorded')}>
          Record {r.fraudReasons.length} fraud flag(s) for review
        </Button>
      )}
      {done.length > 0 && <p className="text-xs text-muted-foreground">Applied so far: {done.map(humanize).join(', ')}</p>}
    </div>
  )
}

export function TriageAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="triage-router"
      description="Severity, complexity, a fraud indicator with reason codes, and a suggested adjuster. The score never decides a claim."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <KeyValue
            columns={3}
            items={[
              { label: 'Severity', value: humanize(r.severity) },
              { label: 'Complexity', value: `${r.complexity} of 4` },
              r.fraudScore != null
                ? { label: 'Fraud indicator', value: `${r.fraudScore} / 100 (${humanize(r.fraudBand)})${r.aboveReviewThreshold ? ' · above review threshold' : ''}` }
                : r.fraudBand && { label: 'Fraud risk band', value: humanize(r.fraudBand) },
              r.fraudReasons && { label: 'Reason codes', value: <List items={r.fraudReasons.map((f) => `${humanize(f.code)} (${humanize(f.severity)}): ${f.explanation}`)} />, wide: true },
              { label: 'Suggested adjuster', value: r.recommendedAdjuster ? `${r.recommendedAdjuster.name} (${r.recommendedAdjuster.openClaims} open claims)` : 'None suggested' },
              { label: 'Routing reason', value: r.routingReason || '—', wide: true },
              { label: 'Rationale', value: r.rationale, wide: true },
            ]}
          />
        )
      }}
      renderApply={(p) => <TriageApply {...p} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Reserve (Reserves tab)
// ---------------------------------------------------------------------------
function ReserveApply({ run, apply, pending }) {
  const lines = run.result.lines
  const [line, setLine] = useState(lines[0].coverageLine)
  const current = lines.find((l) => l.coverageLine === line)
  const [amount, setAmount] = useState(String(current.point))
  const [reason, setReason] = useState('')
  useEffect(() => setAmount(String(current.point)), [line])
  const overridden = Math.abs(Number(amount) - current.point) > 0.005
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Coverage line">
          <Select value={line} onValueChange={setLine} options={lines.map((l) => ({ value: l.coverageLine, label: humanize(l.coverageLine) }))} />
        </FormField>
        <FormField label="Reserve amount (₹)">
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        {overridden && (
          <FormField label="Reason for changing the amount" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        )}
      </div>
      <Button size="sm" variant="accent" loading={pending} disabled={!(Number(amount) > 0) || (overridden && reason.trim().length < 5)} onClick={() => apply({ coverageLine: line, amount: Number(amount), overrideReason: overridden ? reason : undefined }, 'Reserve set')}>
        <CheckCircle2 /> Set reserve
      </Button>
    </>
  )
}

export function ReserveAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="reserve-recommender"
      description="A range and point estimate per coverage line, from the evaluation and comparable settled claims. Within your authority it posts; above it, a Claims Manager reviews."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr><th className="py-1 pr-3">Line</th><th className="pr-3">Low</th><th className="pr-3">Point</th><th className="pr-3">High</th><th>Drivers</th></tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.coverageLine} className="border-t align-top">
                      <td className="py-1.5 pr-3">{humanize(l.coverageLine)}</td>
                      <td className="tabular pr-3">{formatMoney(l.low)}</td>
                      <td className="tabular pr-3 font-semibold">{formatMoney(l.point)}</td>
                      <td className="tabular pr-3">{formatMoney(l.high)}</td>
                      <td>{l.drivers.join('; ')}{l.aboveSumInsured && <span className="block text-amber-800">Above the sum insured</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <KeyValue items={[
              { label: 'Comparables used', value: r.comparablesUsed?.length ? `${r.comparablesUsed.length} of ${r.comparablesAvailable} settled claims` : `None of ${r.comparablesAvailable} available` },
              { label: 'Rationale', value: r.rationale, wide: true },
            ]} />
          </div>
        )
      }}
      renderApply={(p) => <ReserveApply {...p} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Denial letter (Evaluation tab)
// ---------------------------------------------------------------------------
function DenialApply({ run, apply, pending }) {
  const [subject, setSubject] = useState(run.result.subject)
  const [body, setBody] = useState(run.result.body)
  return (
    <>
      <FormField label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></FormField>
      <FormField label="Letter" hint={`Placeholders filled in when saved: ${run.result.placeholders.join(', ')}`}>
        <Textarea className="min-h-72 font-mono text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <Button size="sm" variant="accent" loading={pending} disabled={body.trim().length < 100} onClick={() => apply({ subject, body }, 'Letter approved and saved to the claim documents')}>
        <CheckCircle2 /> Approve and save letter
      </Button>
      <p className="text-xs text-muted-foreground">Approving saves the letter as a PDF in the claim documents. Denying the claim is a separate decision.</p>
    </>
  )
}

export function DenialLetterAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="denial-letter-drafter"
      description="Drafts a plain-language denial letter that cites the policy and file facts. A Claims Manager edits and approves it."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <div className="space-y-3">
            {r.missingNoticeLanguage?.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-amber-900">
                <p className="font-medium">Check before issuing</p>
                <List items={r.missingNoticeLanguage} />
              </div>
            )}
            <KeyValue items={[
              { label: 'Clauses cited', value: <List items={r.citedClauses?.map(clauseText)} /> },
              { label: 'Facts relied on', value: <List items={r.factsReliedOn} /> },
            ]} />
            {!run.canApply && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-3 text-xs">{r.subject}{'\n\n'}{r.body}</pre>}
          </div>
        )
      }}
      renderApply={(p) => <DenialApply {...p} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Payee anomalies (Approvals tab)
// ---------------------------------------------------------------------------
function PayeeApply({ run, apply, pending }) {
  const r = run.result
  const [message, setMessage] = useState(r.anomalies.map((a) => `${humanize(a.code)}: ${a.draftRequest}`).join('\n\n'))
  return (
    <>
      {r.anomalies.length > 0 && (
        <FormField label="Request to the payments team">
          <Textarea className="min-h-28" value={message} onChange={(e) => setMessage(e.target.value)} />
        </FormField>
      )}
      <div className="flex flex-wrap gap-2">
        {r.anomalies.length > 0 && (
          <Button size="sm" variant="accent" loading={pending} disabled={!message.trim()} onClick={() => apply({ createTask: true, message }, 'Task created for the payments team')}>
            Create task for payments team
          </Button>
        )}
        <Button size="sm" variant="outline" loading={pending} onClick={() => apply({ createTask: false }, 'Marked as reviewed')}>
          <CheckCircle2 /> Mark reviewed
        </Button>
      </div>
    </>
  )
}

export function PayeeAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="payee-anomaly"
      description="Looks for new or changed bank details, name mismatches and payees shared across claims. It never decides whether to pay."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <div className="space-y-3">
            <KeyValue columns={3} items={[
              { label: 'Payee', value: r.payee?.name },
              { label: 'Account', value: <span className="font-mono">{r.payee?.account || '—'}</span> },
              { label: 'Verification', value: humanize(r.payee?.verificationStatus) },
              { label: 'System signals', value: r.signals?.length ? r.signals.map(humanize).join(', ') : 'None', wide: true },
            ]} />
            {r.anomalies.length ? (
              <ul className="space-y-2">
                {r.anomalies.map((a) => (
                  <li key={a.code} className="rounded-lg border p-2">
                    <p className="font-medium">{humanize(a.code)}</p>
                    <p className="text-muted-foreground">{a.evidence}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-emerald-800">No anomalies found by the AI.</p>
            )}
            <p>{r.summary}</p>
          </div>
        )
      }}
      renderApply={(p) => <PayeeApply {...p} />}
    />
  )
}

// ---------------------------------------------------------------------------
// Subrogation (Closure & Recovery tab)
// ---------------------------------------------------------------------------
function SubrogationApply({ run, apply, pending }) {
  const r = run.result
  const [type, setType] = useState(r.recommendedType === 'SALVAGE' ? 'SALVAGE' : 'SUBROGATION')
  const [target, setTarget] = useState(r.thirdParties?.[0]?.party || '')
  const [amount, setAmount] = useState('')
  const [deadline, setDeadline] = useState(r.referralBy || r.limitationDeadline || '')
  const tooHigh = amount !== '' && r.amountPaid > 0 && Number(amount) > r.amountPaid
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Type"><Select value={type} onValueChange={setType} options={[{ value: 'SUBROGATION', label: 'Subrogation' }, { value: 'SALVAGE', label: 'Salvage' }]} /></FormField>
        <FormField label="Target party"><Input value={target} onChange={(e) => setTarget(e.target.value)} /></FormField>
        <FormField label="Expected recovery (₹)" hint={r.amountPaid > 0 ? `Up to the ${formatMoney(r.amountPaid)} paid` : 'Optional'} error={tooHigh ? 'Cannot exceed the amount paid' : undefined}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Referral deadline"><Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></FormField>
      </div>
      <Button size="sm" variant="accent" loading={pending} disabled={tooHigh} onClick={() => apply({ type, targetParty: target || undefined, expectedAmount: amount === '' ? undefined : Number(amount), deadline: deadline || undefined }, 'Recovery recorded')}>
        <CheckCircle2 /> Create recovery
      </Button>
    </>
  )
}

export function SubrogationAgentCard({ claim, onApplied }) {
  return (
    <AgentCard
      claim={claim}
      agent="subrogation-assessor"
      description="Who else may be liable, what can be salvaged, and the date a referral must be made by."
      onApplied={onApplied}
      renderResult={(run) => {
        const r = run.result
        return (
          <KeyValue items={[
            { label: 'Recovery likelihood', value: humanize(r.recoveryLikelihood) },
            { label: 'Suggested', value: humanize(r.recommendedType) },
            { label: 'Third parties', value: <List items={r.thirdParties?.map((p) => `${p.party}: ${p.basis} (evidence: ${p.evidence})`)} />, wide: true },
            { label: 'Salvage', value: <List items={r.salvageItems?.map((s) => `${s.item}: ${s.note}`)} />, wide: true },
            { label: 'Refer by', value: r.referralBy ? formatDate(r.referralBy) : '—' },
            { label: 'Limitation deadline', value: r.limitationDeadline ? formatDate(r.limitationDeadline) : '—' },
            { label: 'Rationale', value: r.rationale, wide: true },
          ]} />
        )
      }}
      renderApply={(p) => <SubrogationApply {...p} />}
    />
  )
}
