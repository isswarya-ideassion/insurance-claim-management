import { useEffect, useState } from 'react'
import { Bot, ListChecks, Send, Trash2, Wrench } from 'lucide-react'
import { REMINDER_STATUS_LABELS, REMINDER_TYPE_LABELS } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { useAction } from '@/hooks/useApi.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Label, Textarea } from '@/components/ui/input.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDate, formatDateTime } from '@/utils/format.js'

/** Marks content produced by the AI provider. */
export function AiBadge({ className }) {
  return (
    <Badge tone="violet" className={className}>
      <Bot className="size-3" aria-hidden="true" /> AI-generated — verify before use
    </Badge>
  )
}

/** Marks deterministic, rule-based output (no AI involved). */
export function RuleBadge() {
  return (
    <Badge tone="neutral">
      <ListChecks className="size-3" aria-hidden="true" /> Rule-based
    </Badge>
  )
}

/** Shown instead of AI results when no provider is configured. Never a mock result. */
export function AiSetupNotice({ status }) {
  if (!status || status.configured) return null
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-sm text-amber-900">
      <p className="flex items-center gap-2 font-semibold">
        <Wrench className="size-4" aria-hidden="true" /> AI automation is not configured
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-900/90">
        {status.setup.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

/** Explains an AI failure, with a retry when the error is transient. */
export function AiErrorNotice({ error, onRetry }) {
  if (!error) return null
  const retryable = error.details?.retryable
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50/70 p-3 text-sm text-red-900">
      <p className="font-medium">{error.code === 'AI_NOT_CONFIGURED' ? 'AI automation is not configured' : 'The AI step did not complete'}</p>
      <p className="mt-0.5 text-red-900/80">{error.message}</p>
      {retryable && onRetry && (
        <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

const STATUS_TONES = { SENT: 'teal', DRAFT: 'amber', APPROVED: 'green', DISCARDED: 'neutral' }

export function ReminderStatusBadge({ status }) {
  return <Badge tone={STATUS_TONES[status]} dot>{REMINDER_STATUS_LABELS[status] || status}</Badge>
}

export function ReminderTypeLabel({ type }) {
  return <span>{REMINDER_TYPE_LABELS[type] || type}</span>
}

/**
 * Customer reminder drafts are reviewed (and optionally edited) by a person,
 * then approved — which creates the document requests and notifies the
 * claimant — or discarded.
 */
export function ReminderDraftDialog({ reminder, onClose, onDone }) {
  const [message, setMessage] = useState('')
  const action = useAction()
  useEffect(() => {
    if (reminder) setMessage(reminder.message)
  }, [reminder])
  if (!reminder) return null
  const tooShort = message.trim().length < 20

  async function approve() {
    const done = await action.run(() => automationService.approveReminder(reminder.id, message.trim() === reminder.message ? undefined : message.trim()), {
      success: 'Reminder approved and sent to the claimant',
    })
    if (done) {
      onDone?.()
      onClose()
    }
  }

  async function discard() {
    const done = await action.run(() => automationService.discardReminder(reminder.id), { success: 'Draft discarded' })
    if (done) {
      onDone?.()
      onClose()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review customer reminder</DialogTitle>
          <DialogDescription>
            Nothing has been sent yet. Approving sends this message to {reminder.recipient_name || 'the claimant'} and opens a document request for each item below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5 text-xs">
            {reminder.claim_number && <Badge tone="navy">{reminder.claim_number}</Badge>}
            {reminder.document_categories.map((c) => (
              <Badge key={c} tone="neutral">{c.replaceAll('_', ' ').toLowerCase()}</Badge>
            ))}
            {reminder.due_at && <span className="text-muted-foreground">Response due {formatDate(reminder.due_at)}</span>}
          </div>
          <div>
            <Label htmlFor="reminder-message">Message to the claimant</Label>
            <Textarea id="reminder-message" rows={12} value={message} onChange={(e) => setMessage(e.target.value)} className="mt-1 font-mono text-[13px]" />
            {tooShort && <p className="mt-1 text-xs text-red-700">The message must be at least 20 characters.</p>}
          </div>
          <p className="text-xs text-muted-foreground">
            Prepared {formatDateTime(reminder.created_at)} by {reminder.created_by_name}. The template is rule-based, not AI-generated.
          </p>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={discard} disabled={action.pending}>
            <Trash2 /> Discard draft
          </Button>
          <Button onClick={approve} loading={action.pending} disabled={tooShort}>
            <Send /> Approve and send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
