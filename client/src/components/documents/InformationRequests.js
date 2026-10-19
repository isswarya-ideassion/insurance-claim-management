import { useEffect, useState } from 'react'
import { Inbox, Send, Upload, X } from 'lucide-react'
import { DOCUMENT_CATEGORIES, humanize } from '@shared/constants.js'
import { documentsService } from '@/services/documentsService.js'
import { useAction } from '@/hooks/useApi.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { UploadDocumentDialog } from './DocumentDialogs.js'
import { formatDate, formatRelative, toDateInput } from '@/utils/format.js'

export function RequestInformationDialog({ open, onOpenChange, claimId, onCreated }) {
  const [requestType, setRequestType] = useState('DOCUMENT')
  const [documentCategory, setDocumentCategory] = useState('')
  const [message, setMessage] = useState('')
  const [dueAt, setDueAt] = useState(toDateInput(Date.now() + 7 * 86400000))
  const action = useAction()

  useEffect(() => {
    if (open) {
      setRequestType('DOCUMENT')
      setDocumentCategory('')
      setMessage('')
    }
  }, [open])

  async function submit() {
    const result = await action.run(() => documentsService.createRequest(claimId, { requestType, documentCategory: requestType === 'DOCUMENT' ? documentCategory : undefined, message, dueAt }), {
      success: 'Request sent to the claimant',
    })
    if (result) {
      onCreated?.(result)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request from claimant</DialogTitle>
          <DialogDescription>The claimant is notified and can respond from their portal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Request type" required>
            <Select value={requestType} onValueChange={setRequestType} options={[{ value: 'DOCUMENT', label: 'Missing document' }, { value: 'INFORMATION', label: 'Additional information' }]} />
          </FormField>
          {requestType === 'DOCUMENT' && (
            <FormField label="Document category" required>
              <Select value={documentCategory} onValueChange={setDocumentCategory} placeholder="Select category" options={DOCUMENT_CATEGORIES.filter((c) => !c.endsWith('_EVIDENCE')).map((c) => ({ value: c, label: humanize(c) }))} />
            </FormField>
          )}
          <FormField label="Message to claimant" required>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Explain exactly what is needed and why." />
          </FormField>
          <FormField label="Due date">
            <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={action.pending} disabled={message.trim().length < 5 || (requestType === 'DOCUMENT' && !documentCategory)}>
            <Send /> Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Lists information requests; customers can respond, staff can close. */
export function InformationRequestList({ requests, claimId, customer = false, canClose = false, onChanged, showClaim = false }) {
  const [respondTo, setRespondTo] = useState(null)
  const [response, setResponse] = useState('')
  const [uploadFor, setUploadFor] = useState(null)
  const action = useAction()

  if (!requests?.length) return <EmptyState icon={Inbox} title="No information requests" description={customer ? 'If we need anything else from you, it will appear here.' : undefined} />

  return (
    <>
      <ul className="space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {r.request_type === 'DOCUMENT' ? `Document needed: ${humanize(r.document_category)}` : 'Additional information needed'}
                  {showClaim && r.claim_number && <span className="ml-2 text-xs font-normal text-muted-foreground">{r.claim_number}</span>}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{r.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Requested {formatRelative(r.created_at)}
                  {r.requested_by_name && ` by ${r.requested_by_name}`}
                  {r.due_at && ` · due ${formatDate(r.due_at)}`}
                </p>
                {r.response_text && <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm">Response: {r.response_text}</p>}
              </div>
              <StatusBadge value={r.status} />
            </div>
            {r.status === 'OPEN' && (
              <div className="mt-3 flex flex-wrap gap-2">
                {customer && r.request_type === 'DOCUMENT' && (
                  <Button size="sm" variant="accent" onClick={() => setUploadFor(r)}>
                    <Upload /> Upload document
                  </Button>
                )}
                {customer && r.request_type === 'INFORMATION' && (
                  <Button size="sm" variant="accent" onClick={() => { setRespondTo(r); setResponse('') }}>
                    <Send /> Respond
                  </Button>
                )}
                {canClose && (
                  <Button size="sm" variant="outline" onClick={() => action.run(async () => { await documentsService.closeRequest(r.id); onChanged?.() }, { success: 'Request cancelled' })}>
                    <X /> Cancel request
                  </Button>
                )}
              </div>
            )}
            {r.status === 'RESPONDED' && canClose && (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => action.run(async () => { await documentsService.closeRequest(r.id); onChanged?.() }, { success: 'Request closed' })}>
                Mark resolved
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Dialog open={Boolean(respondTo)} onOpenChange={(o) => !o && setRespondTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Respond to request</DialogTitle>
            <DialogDescription>{respondTo?.message}</DialogDescription>
          </DialogHeader>
          <Textarea value={response} onChange={(e) => setResponse(e.target.value)} aria-label="Your response" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRespondTo(null)}>
              Cancel
            </Button>
            <Button
              loading={action.pending}
              disabled={response.trim().length < 2}
              onClick={async () => {
                const ok = await action.run(() => documentsService.respond(respondTo.id, response), { success: 'Response sent' })
                if (ok) {
                  setRespondTo(null)
                  onChanged?.()
                }
              }}
            >
              Send response
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UploadDocumentDialog
        open={Boolean(uploadFor)}
        onOpenChange={(o) => !o && setUploadFor(null)}
        claimId={uploadFor?.claim_id || claimId}
        customer={customer}
        defaultCategory={uploadFor?.document_category}
        informationRequestId={uploadFor?.id}
        onUploaded={() => onChanged?.()}
      />
    </>
  )
}
