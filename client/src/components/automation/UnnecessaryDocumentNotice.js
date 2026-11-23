import { useState } from 'react'
import { Ban, CheckCircle2, FileX2 } from 'lucide-react'
import { humanize } from '@shared/constants.js'
import { documentsService } from '@/services/documentsService.js'
import { useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { cn } from '@/lib/utils.js'

/** Same text as the server's IRRELEVANT_REJECTION_REASON (services/intelligence/documentRelevance.js). */
export const IRRELEVANT_REJECTION_REASON = 'Unnecessary / unrelated document flagged by Beacon AI'

/** True when a Beacon result marks the file as unrelated to the claim. */
export const isIrrelevant = (x) => x?.relevance === 'IRRELEVANT' || x?.status === 'IRRELEVANT'

/**
 * Beacon found nothing in this file that relates to the claim. Not a fraud
 * alert: the reviewer either keeps the file or rejects it in one click (the
 * normal document rejection: claimant notified, reason recorded, audited).
 *
 * `documentStatus` is the document's review status when the caller knows it;
 * without it the button is shown and the server decides.
 */
export function UnnecessaryDocumentNotice({ documentId, fileName, detail, notes = [], documentStatus, onRejected, className }) {
  const { can } = useAuth()
  const action = useAction()
  const [rejectedNow, setRejectedNow] = useState(false)
  const rejected = rejectedNow || documentStatus === 'REJECTED'
  const reviewable = !documentStatus || documentStatus === 'PENDING_REVIEW'

  async function reject() {
    const result = await action.run(
      () =>
        documentsService.review(documentId, {
          decision: 'REJECT',
          rejectionReason: IRRELEVANT_REJECTION_REASON,
          comment: 'Rejected from the Beacon AI unnecessary-document notice.',
          beaconFlag: 'IRRELEVANT_DOCUMENT',
        }),
      { success: 'Document rejected — the claimant has been asked for the right document' },
    )
    if (result) {
      setRejectedNow(true)
      onRejected?.(result)
    }
  }

  return (
    <section role="status" aria-label="Unnecessary or non-claim document" className={cn('rounded-xl border border-amber-300 bg-amber-50 p-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <FileX2 className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-amber-950">Unnecessary / Non-Claim Document — No relevant claim evidence found.</h3>
            <p className="text-sm text-amber-950/80">
              {fileName ? <span className="break-all font-medium">{fileName}: </span> : null}
              Beacon AI found no invoice, medical, repair, or policy details matching this claim.
            </p>
            {detail && <p className="mt-1 text-xs text-amber-950/70">{detail}</p>}
            {notes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-amber-950/70">
                {notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {rejected ? (
          <Badge tone="neutral">
            <CheckCircle2 className="size-3" aria-hidden="true" /> Document rejected
          </Badge>
        ) : !reviewable ? (
          <Badge tone="neutral">Already {humanize(documentStatus).toLowerCase()}</Badge>
        ) : (
          can('documents.review') && (
            <Button size="sm" variant="outline" className="border-amber-400 bg-white" loading={action.pending} onClick={reject}>
              <Ban /> Reject Document
            </Button>
          )
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">An indicator from Beacon's local check, not a decision. If the file is genuine, keep it and review it as usual.</p>
    </section>
  )
}
