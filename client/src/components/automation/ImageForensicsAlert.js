import { useState } from 'react'
import { CheckCircle2, Copy, FileWarning, ScanSearch, ShieldAlert } from 'lucide-react'
import { humanize } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { formatDate, formatDateTime, formatMoney } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'
import { UnnecessaryDocumentNotice, isIrrelevant } from '@/components/automation/UnnecessaryDocumentNotice.js'

/*
 * Beacon AI Image Forensics Alert — local, zero-cost checks on image documents:
 * the same file on another claim, editing-software or AI metadata, a capture
 * date before the loss, and the OCR'd bill total and date against the claim.
 * An alert is an indicator for a person; accepting it records a fraud flag for
 * compliance to review. It never decides the claim.
 */

const CHECK_LABELS = {
  DUPLICATE_IMAGE: 'Duplicate image on another claim',
  EDITING_SOFTWARE: 'Editing software in metadata',
  AI_GENERATED: 'Generative-AI marker',
  MODIFIED_AFTER_CAPTURE: 'Edited after capture',
  CAPTURED_BEFORE_LOSS: 'Captured before the loss',
  AMOUNT_MISMATCH: 'Bill total differs from claim',
  BILL_DATE_BEFORE_LOSS: 'Bill dated before the loss',
}

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`

function AlertItem({ alert, high }) {
  return (
    <li className={cn('rounded-lg border bg-white/70 p-3', high ? 'border-red-200' : 'border-amber-200')}>
      <div className="flex flex-wrap items-center gap-2">
        <FileWarning className={cn('size-4 shrink-0', high ? 'text-red-600' : 'text-amber-600')} aria-hidden="true" />
        <span className="break-all font-medium">{alert.fileName}</span>
        <Badge tone={high ? 'red' : 'amber'}>{humanize(alert.riskLevel)} risk</Badge>
        <Badge tone="neutral">Confidence {pct(alert.confidence)}</Badge>
        {alert.matchedClaimNumber && (
          <Badge tone="red">
            <Copy className="size-3" aria-hidden="true" /> Matches {alert.matchedClaimNumber}
          </Badge>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {alert.checks.map((c, i) => (
          <li key={`${c.check}-${i}`} className="text-sm">
            <span className="font-medium">{CHECK_LABELS[c.check] || humanize(c.check)}</span>
            <span className="text-muted-foreground"> · {humanize(c.severity).toLowerCase()} · {pct(c.confidence)}</span>
            <p className="text-[13px] text-foreground/80">{c.evidence}</p>
          </li>
        ))}
      </ul>
      {(alert.ocr?.amount != null || alert.ocr?.billDate || alert.ocr?.note) && (
        <p className="mt-2 text-xs text-muted-foreground">
          OCR: {alert.ocr.read ? `total ${alert.ocr.amount != null ? formatMoney(alert.ocr.amount) : 'not found'}, bill date ${alert.ocr.billDate ? formatDate(alert.ocr.billDate) : 'not found'}` : alert.ocr.note}
        </p>
      )}
    </li>
  )
}

/**
 * Beacon's image results. Fraud alerts share one red/amber banner with
 * "Accept Alert & Flag Fraud"; a file Beacon judged unrelated to the claim
 * gets its own notice with "Reject Document" instead, never the fraud action.
 * `accepted` is `{ by, at }` once a person accepted the fraud alert; `onAccept`
 * is omitted for roles that cannot accept. `documentStatus` is known only when
 * the banner is about one document.
 */
export function ImageForensicsAlert({ alerts, accepted, onAccept, pending, documentStatus, onRejected, className }) {
  if (!alerts?.length) return null
  const fraud = alerts.filter((a) => !isIrrelevant(a))
  const unrelated = alerts.filter(isIrrelevant)
  return (
    <div className={cn('space-y-3', className)}>
      {fraud.length > 0 && <FraudAlertBanner alerts={fraud} accepted={accepted} onAccept={onAccept} pending={pending} />}
      {unrelated.map((a) => (
        <UnnecessaryDocumentNotice
          key={a.documentId}
          documentId={a.documentId}
          fileName={unrelated.length > 1 || fraud.length > 0 ? a.fileName : null}
          detail={a.relevanceDetail}
          notes={a.evidence.filter((e) => e.startsWith('Also noted'))}
          documentStatus={documentStatus}
          onRejected={onRejected}
        />
      ))}
    </div>
  )
}

function FraudAlertBanner({ alerts, accepted, onAccept, pending, className }) {
  const high = alerts.some((a) => a.riskLevel === 'HIGH')
  const top = alerts[0]
  return (
    <section
      role="alert"
      aria-label="Beacon AI Image Forensics Alert"
      className={cn('rounded-xl border-2 p-4', high ? 'border-red-400 bg-red-50' : 'border-amber-400 bg-amber-50', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <ShieldAlert className={cn('mt-0.5 size-5 shrink-0', high ? 'text-red-600' : 'text-amber-600')} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className={cn('text-sm font-bold uppercase tracking-wide', high ? 'text-red-800' : 'text-amber-900')}>Beacon AI Image Forensics Alert</h3>
            <p className={cn('text-sm', high ? 'text-red-900/90' : 'text-amber-900/90')}>
              {alerts.length === 1 ? 'One image' : `${alerts.length} images`} on this claim carry fraud indicators · highest risk {humanize(top.riskLevel).toLowerCase()} · confidence {pct(top.confidence)}
              {top.matchedClaimNumber ? ` · same file as claim ${top.matchedClaimNumber}` : ''}
            </p>
          </div>
        </div>
        {accepted ? (
          <Badge tone="green">
            <CheckCircle2 className="size-3" aria-hidden="true" /> Accepted{accepted.by ? ` by ${accepted.by}` : ''}{accepted.at ? ` · ${formatDateTime(accepted.at)}` : ''} — fraud flag recorded
          </Badge>
        ) : (
          onAccept && (
            <Button size="sm" variant="destructive" loading={pending} onClick={onAccept}>
              <ShieldAlert /> Accept Alert &amp; Flag Fraud
            </Button>
          )
        )}
      </div>
      <ul className="mt-3 space-y-2">
        {alerts.map((a) => (
          <AlertItem key={a.documentId} alert={a} high={a.riskLevel === 'HIGH'} />
        ))}
      </ul>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <ScanSearch className="size-3" aria-hidden="true" /> Checked locally by Beacon ({top.engine}) — no image left the server. An indicator for review, not a finding of fraud.
      </p>
    </section>
  )
}

/** Alert attached to an AI suggestion (triage-router or intake-parser run). */
export function RunImageForensicsAlert({ run, onAccepted, onRejected, documentStatus, className }) {
  const { can } = useAuth()
  const action = useAction()
  const [acceptedNow, setAcceptedNow] = useState(false)
  const alerts = run?.result?.imageFraudAlerts
  if (!can('fraud.imageAlerts.view') || !alerts?.length) return null
  const accepted = acceptedNow || (run.applied_fields || []).includes('image_fraud_alert')
  async function accept() {
    const done = await action.run(() => automationService.acceptRunImageAlert(run.id), {
      success: (r) => (r?.fraudFlagsRecorded?.length ? `Alert accepted — ${r.fraudFlagsRecorded.length} fraud flag(s) recorded for compliance review` : 'Alert accepted — matching fraud flags were already open on this claim'),
    })
    if (done) {
      setAcceptedNow(true)
      onAccepted?.()
    }
  }
  return (
    <ImageForensicsAlert
      className={className}
      alerts={alerts}
      accepted={accepted ? { by: acceptedNow ? 'you' : run.decided_by_name, at: acceptedNow ? null : run.decided_at } : null}
      onAccept={can('fraud.imageAlerts.accept') && run.human_decision !== 'REJECTED' ? accept : undefined}
      pending={action.pending}
      documentStatus={documentStatus}
      onRejected={onRejected}
    />
  )
}

/** Live scan of one image document, for the Document Review and preview dialogs. */
export function DocumentImageForensicsPanel({ document, onRejected, className }) {
  const { can } = useAuth()
  const isImage = Boolean(document?.mime_type?.startsWith('image/'))
  const enabled = isImage && can('fraud.imageAlerts.view')
  const query = useApiQuery(() => automationService.documentImageForensics(document.id), [document?.id], { enabled })
  const action = useAction()
  if (!enabled) return null
  if (query.loading && !query.data) {
    return (
      <p className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}>
        <ScanSearch className="size-4 animate-pulse" aria-hidden="true" /> Beacon is scanning this image for tampering…
      </p>
    )
  }
  const data = query.data
  if (!data?.applicable) return null
  if (!data.alert) {
    return (
      <p className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <CheckCircle2 className="size-4 text-emerald-600" aria-hidden="true" /> Beacon image forensics: no duplicate, editing or OCR indicators found.
      </p>
    )
  }
  async function accept() {
    const result = await action.run(() => automationService.acceptDocumentImageAlert(document.id), {
      success: (r) => (r?.fraudFlagsRecorded?.length ? `Alert accepted — ${r.fraudFlagsRecorded.length} fraud flag(s) recorded for compliance review` : 'Alert accepted — matching fraud flags were already open on this claim'),
    })
    if (result) query.setData(result)
  }
  return (
    <ImageForensicsAlert
      className={className}
      alerts={[data.alert]}
      accepted={data.accepted}
      onAccept={can('fraud.imageAlerts.accept') && data.canAccept ? accept : undefined}
      pending={action.pending}
      documentStatus={data.documentStatus ?? document.status}
      onRejected={onRejected}
    />
  )
}
