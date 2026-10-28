import { useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, Download, Eye, FileText, History, MoreHorizontal, Upload, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { humanize } from '@shared/constants.js'
import { documentsService, saveBlob } from '@/services/documentsService.js'
import { useAuth } from '@/context/AuthContext.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js'
import { cn } from '@/lib/utils.js'
import { DocumentPreviewDialog, ReviewDocumentDialog, UploadDocumentDialog } from './DocumentDialogs.js'
import { formatDateTime, formatFileSize, formatRelative } from '@/utils/format.js'

export function RequiredDocumentsChecklist({ required = [], documents = [], exception }) {
  if (!required.length) return null
  return (
    <div className="rounded-lg border bg-muted/40 p-4">
      <p className="text-sm font-medium">Required documents</p>
      {exception && <p className="mt-1 text-xs text-violet-700">Document exception recorded: {exception}</p>}
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {required.map((cat) => {
          const docs = documents.filter((d) => d.doc_type === cat)
          const accepted = docs.some((d) => d.status === 'ACCEPTED')
          const pending = docs.some((d) => d.status === 'PENDING_REVIEW')
          // Status is shown as an icon and words, never as an empty selectable-looking circle.
          const state = accepted
            ? { Icon: CheckCircle2, tone: 'text-emerald-600', label: 'Accepted' }
            : pending
              ? { Icon: Clock, tone: 'text-sky-600', label: 'Uploaded, awaiting review' }
              : { Icon: AlertCircle, tone: 'text-amber-600', label: docs.length ? 'Rejected, upload again' : 'Missing' }
          return (
            <li key={cat} className="flex items-center gap-2 text-sm">
              <state.Icon className={cn('size-4 shrink-0', state.tone)} aria-hidden="true" />
              <span>{humanize(cat)}</span>
              <span className="text-xs text-muted-foreground">{state.label}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function DocumentList({ documents, claimId, customer = false, canUpload = false, onChanged }) {
  const { can, user } = useAuth()
  const [preview, setPreview] = useState(null)
  const [review, setReview] = useState(null)
  const [replace, setReplace] = useState(null)
  const [versions, setVersions] = useState(null)
  const canReview = !customer && can('documents.review')
  const canAssign = !customer && can('documents.assignReviewer')

  if (!documents?.length) return <EmptyState icon={FileText} title="No documents uploaded" description={customer ? 'Upload supporting documents to help us process your claim.' : undefined} />

  async function download(doc, version) {
    try {
      saveBlob(await documentsService.download(doc.id, 'attachment', version), doc.file_name)
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function assignToMe(doc) {
    try {
      await documentsService.assignReviewer(doc.id, user.id)
      toast.success('Document assigned to you')
      onChanged?.()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function showVersions(doc) {
    try {
      setVersions({ doc, rows: await documentsService.versions(doc.id) })
    } catch (err) {
      toast.error(err.message)
    }
  }

  const visible = documents.filter((d) => d.status !== 'SUPERSEDED')
  return (
    <>
      <ul className="divide-y rounded-lg border">
        {visible.map((doc) => (
          <li key={doc.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                <FileText className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{doc.file_name}</p>
                <p className="text-xs text-muted-foreground">
                  {humanize(doc.doc_type)} · v{doc.version} · {formatFileSize(doc.size_bytes)} · received {formatRelative(doc.received_at)}
                  {!customer && doc.uploaded_by_name && ` by ${doc.uploaded_by_name}`}
                </p>
                {doc.status === 'REJECTED' && doc.rejection_reason && <p className="mt-1 text-xs font-medium text-red-700">Rejected: {doc.rejection_reason}</p>}
                {!customer && doc.reviewed_by_name && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Reviewed by {doc.reviewed_by_name} · {formatDateTime(doc.reviewed_at)}
                    {doc.review_comment && ` — “${doc.review_comment}”`}
                  </p>
                )}
                {!customer && doc.status === 'PENDING_REVIEW' && (
                  <p className="mt-0.5 text-xs text-muted-foreground">Reviewer: {doc.reviewer_name || 'unassigned'}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge value={doc.status} />
              {canReview && doc.status === 'PENDING_REVIEW' && (
                <Button size="sm" variant="accent" onClick={() => setReview(doc)}>
                  Review
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" onClick={() => setPreview(doc)} aria-label={`Preview ${doc.file_name}`}>
                <Eye />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${doc.file_name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => download(doc)}>
                    <Download /> Download
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => showVersions(doc)}>
                    <History /> Version history
                  </DropdownMenuItem>
                  {canUpload && (
                    <DropdownMenuItem onSelect={() => setReplace(doc)}>
                      <Upload /> Upload new version
                    </DropdownMenuItem>
                  )}
                  {canAssign && doc.status === 'PENDING_REVIEW' && doc.reviewer_id !== user.id && (
                    <DropdownMenuItem onSelect={() => assignToMe(doc)}>
                      <UserCheck /> Assign to me
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        ))}
      </ul>
      <DocumentPreviewDialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)} document={preview} />
      <ReviewDocumentDialog open={Boolean(review)} onOpenChange={(o) => !o && setReview(null)} document={review} onReviewed={() => onChanged?.()} />
      <UploadDocumentDialog open={Boolean(replace)} onOpenChange={(o) => !o && setReplace(null)} claimId={claimId} customer={customer} replaces={replace} onUploaded={() => onChanged?.()} />
      <Dialog open={Boolean(versions)} onOpenChange={(o) => !o && setVersions(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
          </DialogHeader>
          <ol className="space-y-2">
            {versions?.rows.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                <div>
                  <p className="font-medium">
                    v{v.version_no} · {v.file_name}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(v.uploaded_at)}</p>
                  {v.rejection_reason && <p className="text-xs text-red-700">Rejected: {v.rejection_reason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge value={v.status} />
                  <Button size="icon-sm" variant="ghost" aria-label={`Download version ${v.version_no}`} onClick={() => download(versions.doc, v.version_no)}>
                    <Download />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </>
  )
}
