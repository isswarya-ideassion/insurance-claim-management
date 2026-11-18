import { RefreshCw, ScanSearch } from 'lucide-react'
import { automationService } from '@/services/automationService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Button } from '@/components/ui/button.js'
import { Skeleton, Tooltip } from '@/components/ui/misc.js'
import { AiBadge } from '@/components/automation/AutomationComponents.js'
import { formatDateTime, formatMoney } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'
import { UnnecessaryDocumentNotice, isIrrelevant } from '@/components/automation/UnnecessaryDocumentNotice.js'

/*
 * Beacon reads each document automatically (on upload, or on first view as a
 * fallback), so reviewers no longer start extraction by hand. These pieces
 * show that scan: a skeleton while it runs, a small re-scan icon, and a
 * read-only summary for the Document Review dialog.
 */

/** Placeholder shown while Beacon reads a document. */
export function ScanningSkeleton({ className }) {
  return (
    <div className={cn('space-y-2 rounded-lg border border-dashed p-3', className)} role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ScanSearch className="size-4 animate-pulse text-violet-600" aria-hidden="true" /> Beacon AI scanning document…
      </p>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  )
}

/** Secondary icon button that runs the extraction again. */
export function RescanButton({ onClick, loading, disabled, label = 'Re-scan with Beacon' }) {
  return (
    <Tooltip content={label}>
      <Button size="icon-sm" variant="ghost" onClick={onClick} loading={loading} disabled={disabled} aria-label={label}>
        {!loading && <RefreshCw />}
      </Button>
    </Tooltip>
  )
}

function fieldText(f) {
  if (f.key === 'loss_date') return formatDateTime(f.value)
  if (f.key === 'estimated_loss') return formatMoney(f.value)
  return String(f.value)
}

/**
 * Document Review dialog: makes sure the current version has been scanned
 * (scanning it now if not), then lists what Beacon read. Values are applied
 * to the claim from the Automation tab, not from here.
 */
export function DocumentAiScanPanel({ document, onRejected, className }) {
  const { can } = useAuth()
  const enabled = Boolean(document?.id) && can('automation.extract')
  const query = useApiQuery(() => automationService.ensureExtraction(document.id), [document?.id, document?.version], { enabled, keepPrevious: false })
  const action = useAction()
  if (!enabled) return null
  if (query.loading && !query.data) return <ScanningSkeleton className={className} />
  if (query.error) return null

  const run = query.data?.run
  async function rescan() {
    const fresh = await action.run(() => automationService.extract(document.id), { success: 'Document re-scanned' })
    if (fresh && fresh !== true) query.setData((d) => ({ ...d, run: fresh }))
  }
  if (!run) return null

  const found = (run.result?.fields || []).filter((f) => f.value !== null && f.value !== undefined && f.value !== '')
  // Images show the unrelated-document notice in their forensics panel; other files show it here.
  const unrelatedFile = !document.mime_type?.startsWith('image/') && isIrrelevant(run.result?.relevance)
  return (
    <div className={cn('space-y-3', className)}>
    {unrelatedFile && (
      <UnnecessaryDocumentNotice documentId={document.id} detail={run.result.relevance.detail} documentStatus={document.status} onRejected={onRejected} />
    )}
    <section className="rounded-lg border border-violet-200 bg-violet-50/40 p-3" aria-label="What Beacon read from this document">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">What Beacon read</span>
          <AiBadge />
          <span className="text-xs text-muted-foreground">{formatDateTime(run.created_at)}</span>
        </div>
        {action.pending ? <ScanSearch className="size-4 animate-pulse text-violet-600" aria-label="Scanning" /> : <RescanButton onClick={rescan} />}
      </div>
      {run.status === 'FAILED' ? (
        <p className="mt-2 text-sm text-red-700">Beacon could not read this document. Re-scan it, or check the file by eye.</p>
      ) : found.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No claim fields could be read from this document.</p>
      ) : (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {found.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{f.label}</dt>
              <dd className="break-words">
                {fieldText(f)} <span className="text-xs text-muted-foreground">· {Math.round(f.confidence * 100)}%</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Read automatically. Check the values against the document; they are saved to the claim only from the Automation tab.</p>
    </section>
    </div>
  )
}
