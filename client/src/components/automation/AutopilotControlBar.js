import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, ChevronDown, Clock, FileCheck2, Play, ShieldAlert, Zap } from 'lucide-react'
import { AUTOPILOT_STAGES } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Button } from '@/components/ui/button.js'
import { Badge } from '@/components/ui/badge.js'
import { Switch, Tooltip } from '@/components/ui/misc.js'
import { cn } from '@/lib/utils.js'
import { formatRelative } from '@/utils/format.js'

const fmt = (n) => (n == null ? '—' : new Intl.NumberFormat('en-IN').format(n))

function timeSaved(minutes) {
  if (minutes == null) return '—'
  if (minutes < 60) return `${minutes} min`
  const h = minutes / 60
  return `${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} hrs`
}

function Metric({ label, value, hint, icon: Icon, tone }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border bg-card/80 px-3 py-2.5">
      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', tone)}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <motion.p key={String(value)} initial={{ opacity: 0.4, y: 3 }} animate={{ opacity: 1, y: 0 }} className="tabular text-xl font-semibold leading-tight text-foreground">
          {value}
        </motion.p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}

/** The outcome of the sweep just run, so the audience sees what happened where. */
function SweepResult({ result, onClose }) {
  const [open, setOpen] = useState(true)
  if (!result) return null
  if (!result.ran) {
    return <p className="mt-3 text-xs text-muted-foreground">Sweep did not run ({result.reason === 'DISABLED' ? 'auto-pilot is off' : 'Beacon provider not active'}).</p>
  }
  const stages = Object.entries(result.byStage || {}).filter(([, s]) => s.automated || s.escalated)
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3 overflow-hidden rounded-lg border bg-card/80">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <p className="text-sm">
          <span className="font-medium">Sweep complete:</span> {result.automated} handled automatically, {result.escalated} escalated to people
          {result.minutesSaved ? `, about ${timeSaved(result.minutesSaved)} saved` : ''}.
          {result.errors?.length ? <span className="text-amber-700"> {result.errors.length} item(s) skipped.</span> : null}
        </p>
        <div className="flex items-center gap-1">
          {result.actions?.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Details <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>Dismiss</Button>
        </div>
      </div>
      {stages.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t px-3 py-2">
          {stages.map(([key, s]) => (
            <Badge key={key} tone="neutral">
              {AUTOPILOT_STAGES[key]?.label || key}: {s.automated > 0 && <span className="text-emerald-700">{s.automated} auto</span>}
              {s.automated > 0 && s.escalated > 0 && ' · '}
              {s.escalated > 0 && <span className="text-amber-700">{s.escalated} to people</span>}
            </Badge>
          ))}
        </div>
      )}
      {open && result.actions?.length > 0 && (
        <ul className="max-h-56 divide-y overflow-y-auto border-t text-sm">
          {result.actions.map((a, i) => (
            <li key={`${a.action}-${a.claimId}-${a.documentId || i}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate">
                <Link to={`/claims/${a.claimId}${a.documentId ? '?tab=documents' : ''}`} className="font-medium text-primary hover:underline">{a.claimNumber}</Link>
                <span className="text-muted-foreground"> · {AUTOPILOT_STAGES[a.stage]?.label}</span>
              </span>
              <Badge tone={a.outcome === 'AUTOMATED' ? 'green' : 'amber'}>{actionLabel(a)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  )
}

const ACTION_LABELS = {
  AI_AUTOPILOT_COVERAGE_VERIFIED: 'Coverage verified',
  AI_AUTOPILOT_INTAKE_ESCALATED: 'Intake → Claims Ops',
  AI_AUTOPILOT_ADJUSTER_ASSIGNED: 'Adjuster assigned',
  AI_AUTOPILOT_ROUTING_ESCALATED: 'Routing → Claims Ops',
  AI_AUTOPILOT_DOC_ACCEPTED: 'Document accepted',
  AI_AUTOPILOT_DOC_REJECTED: 'Unnecessary doc rejected',
  AI_AUTOPILOT_DOC_ESCALATED: 'Document → reviewer',
  AI_AUTOPILOT_DOCS_COMPLETE: 'Docs complete → triage',
  AI_AUTOPILOT_PRECOMPUTED: 'Reserve + subrogation ready',
  AI_AUTOPILOT_PAYEE_SCREENED: 'Payee pre-screened',
  AI_AUTOPILOT_PAYEE_FLAGGED: 'Payee flagged',
  AI_AUTOPILOT_COMPLIANCE_FLAGGED: 'Fraud → Compliance',
}
const actionLabel = (a) => ACTION_LABELS[a.action] || a.label || a.action

/**
 * Beacon AI Auto-Pilot control bar: on/off, a live sweep, and four ROI
 * metrics. Shown on the Operations, Manager, Document Review and Automation
 * workspaces. `onSweep` lets the page reload its own queue afterwards.
 */
export function AutopilotControlBar({ onSweep, className }) {
  const { can } = useAuth()
  const visible = can('autopilot.view')
  const summary = useApiQuery(() => automationService.autopilotSummary(), [], { enabled: visible })
  // Locked while in flight (plus a short cooldown) so a double click never toggles twice or starts two sweeps.
  const toggle = useAction({ lock: true, cooldownMs: 600 })
  const sweep = useAction({ lock: true, cooldownMs: 1000 })
  const [result, setResult] = useState(null)
  if (!visible) return null

  const s = summary.data
  const t = s?.totals
  const enabled = Boolean(s?.enabled)
  const ready = Boolean(s?.providerReady)
  const canManage = can('autopilot.manage')
  const canRun = can('autopilot.run')

  const onToggle = (next) =>
    toggle.run(async () => {
      const state = await automationService.setAutopilotEnabled(next)
      summary.setData((d) => ({ ...d, ...state }))
      return state
    }, { success: next ? 'Beacon AI Auto-Pilot is on' : 'Beacon AI Auto-Pilot is off' })

  const onRun = () =>
    sweep.run(async () => {
      const r = await automationService.runAutopilot()
      setResult(r)
      await summary.reload()
      await onSweep?.(r)
      return r
    })

  return (
    <section
      aria-label="Beacon AI Auto-Pilot"
      className={cn('mb-5 rounded-xl border bg-gradient-to-r from-violet-50 via-card to-teal-50/60 p-4 shadow-sm', enabled && ready ? 'border-violet-200' : 'border-border', className)}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className={cn('relative flex size-10 shrink-0 items-center justify-center rounded-lg', enabled && ready ? 'bg-violet-600 text-white' : 'bg-slate-200 text-slate-600')}>
            <Bot className="size-5" aria-hidden="true" />
            {enabled && ready && <span className="absolute -right-0.5 -top-0.5 size-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-card" aria-hidden="true" />}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Beacon AI Auto-Pilot</h2>
              <Badge tone={enabled && ready ? 'green' : 'neutral'} dot>{!ready ? 'Unavailable' : enabled ? 'ON' : 'OFF'}</Badge>
              <Badge tone="violet">Local · ₹0 per run</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {ready
                ? 'Routine intake, documents and adjuster pre-work go straight through; fraud and exceptions stay with people. Never approves, pays or denies.'
                : 'Needs AI_PROVIDER=beacon on the server (local, zero-cost).'}
              {s?.lastSweepAt && <span> Last sweep {formatRelative(s.lastSweepAt)}.</span>}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Tooltip content={canManage ? null : 'Claims Managers and Compliance switch the auto-pilot on or off'}>
            <label className="inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium">
              <Switch checked={enabled} disabled={!canManage || !ready || toggle.pending || !s} onCheckedChange={onToggle} aria-label="Beacon AI Auto-Pilot on or off" />
              {enabled ? 'On' : 'Off'}
            </label>
          </Tooltip>
          {canRun && (
            <Button variant="accent" onClick={onRun} loading={sweep.pending} disabled={!enabled || !ready}>
              {!sweep.pending && <Play />} Run Auto-Pilot Sweep
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Routine tasks automated" value={fmt(t?.routineTasksAutomated)} hint={t?.stpRate != null ? `${t.stpRate}% straight-through · ${s.windowDays} days` : `Last ${s?.windowDays ?? 30} days`} icon={Zap} tone="bg-violet-100 text-violet-700" />
        <Metric label="Docs auto-handled" value={fmt(t?.docsAutoHandled)} hint="Accepted, rejected or completed" icon={FileCheck2} tone="bg-teal-100 text-teal-700" />
        <Metric
          label="Fraud / exceptions escalated"
          value={fmt(t?.escalated)}
          hint={t ? `${fmt(t.fraudAlertsCaught)} fraud alerts · ${fmt(t.humanExceptionsRemaining)} still open` : null}
          icon={ShieldAlert}
          tone="bg-amber-100 text-amber-700"
        />
        <Metric label="Est. time saved" value={timeSaved(t?.minutesSaved)} hint="Routine handling minutes replaced" icon={Clock} tone="bg-emerald-100 text-emerald-700" />
      </div>

      <AnimatePresence>{result && <SweepResult result={result} onClose={() => setResult(null)} />}</AnimatePresence>
    </section>
  )
}
