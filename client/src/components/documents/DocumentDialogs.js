import { useEffect, useRef, useState } from 'react'
import { Download, FileUp, UploadCloud } from 'lucide-react'
import { DOCUMENT_TYPES, INTERNAL_DOCUMENT_TYPES, ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES, humanize } from '@shared/constants.js'
import { documentsService, saveBlob } from '@/services/documentsService.js'
import { useAction } from '@/hooks/useApi.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { FormField } from '@/components/common/FormField.js'
import { formatFileSize } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

const CUSTOMER_DOC_TYPES = DOCUMENT_TYPES.filter((c) => !INTERNAL_DOCUMENT_TYPES.includes(c))

export function UploadDocumentDialog({ open, onOpenChange, claimId, customer = false, defaultDocType, replaces, artifactRequirementId, onUploaded }) {
  const [docType, setDocType] = useState(defaultDocType || '')
  const [file, setFile] = useState(null)
  const [localError, setLocalError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const action = useAction()

  useEffect(() => {
    if (open) {
      setDocType(replaces?.doc_type || defaultDocType || '')
      setFile(null)
      setLocalError(null)
    }
  }, [open, defaultDocType, replaces])

  function pick(f) {
    setLocalError(null)
    if (!f) return
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(f.type)) return setLocalError('Only PDF, JPEG, PNG or WebP files are accepted.')
    if (f.size > MAX_UPLOAD_BYTES) return setLocalError('Files must be 10 MB or smaller.')
    setFile(f)
  }

  async function submit() {
    const result = await action.run(
      () => documentsService.upload(claimId, { file, docType, artifactRequirementId, replacesDocumentId: replaces?.id }),
      { success: replaces ? 'New version uploaded' : 'Document uploaded' },
    )
    if (result) {
      onUploaded?.(result)
      onOpenChange(false)
    }
  }

  const docTypes = customer ? CUSTOMER_DOC_TYPES : DOCUMENT_TYPES
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{replaces ? `Upload new version of ${replaces.file_name}` : 'Upload document'}</DialogTitle>
          <DialogDescription>Files are stored privately and are only visible to people authorized for this claim. PDF, JPEG, PNG or WebP up to 10 MB.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Document type" required>
            <Select value={docType} onValueChange={setDocType} placeholder="Select document type" disabled={Boolean(replaces)} options={docTypes.map((c) => ({ value: c, label: humanize(c) }))} />
          </FormField>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              pick(e.dataTransfer.files?.[0])
            }}
            className={cn('flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center', dragging ? 'border-accent bg-teal-50' : 'border-border')}
          >
            <UploadCloud className="size-8 text-muted-foreground" aria-hidden="true" />
            {file ? (
              <p className="text-sm">
                <span className="font-medium">{file.name}</span> · {formatFileSize(file.size)}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Drag a file here or choose one</p>
            )}
            <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="sr-only" id="doc-file" onChange={(e) => pick(e.target.files?.[0])} />
            <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              <FileUp /> Choose file
            </Button>
          </div>
          {localError && <p className="text-sm font-medium text-destructive" role="alert">{localError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={action.pending} disabled={!file || !docType}>
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ReviewDocumentDialog({ open, onOpenChange, document, onReviewed }) {
  const [decision, setDecision] = useState('ACCEPT')
  const [comment, setComment] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')
  const action = useAction()

  useEffect(() => {
    if (open) {
      setDecision('ACCEPT')
      setComment('')
      setRejectionReason('')
    }
  }, [open])

  async function submit() {
    const result = await action.run(() => documentsService.review(document.id, { decision, comment: comment || undefined, rejectionReason: rejectionReason || undefined }), {
      success: decision === 'ACCEPT' ? 'Document accepted' : 'Document rejected — claimant notified and follow-up task created',
    })
    if (result) {
      onReviewed?.(result)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review document</DialogTitle>
          <DialogDescription>
            {document?.file_name} · {humanize(document?.doc_type)} · version {document?.version}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Decision">
            {['ACCEPT', 'REJECT'].map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={decision === d}
                onClick={() => setDecision(d)}
                className={cn(
                  'rounded-lg border p-3 text-sm font-medium',
                  decision === d ? (d === 'ACCEPT' ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-red-500 bg-red-50 text-red-800') : 'hover:bg-muted',
                )}
              >
                {d === 'ACCEPT' ? 'Accept' : 'Reject'}
              </button>
            ))}
          </div>
          {decision === 'REJECT' && (
            <FormField label="Rejection reason (shared with claimant)" required hint="The claimant is notified and asked to upload a replacement.">
              <Textarea value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} placeholder="e.g. Image too blurry to read the invoice total" />
            </FormField>
          )}
          <FormField label="Internal review comment">
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={decision === 'REJECT' ? 'destructive' : 'accent'} onClick={submit} loading={action.pending} disabled={decision === 'REJECT' && rejectionReason.trim().length < 5}>
            {decision === 'ACCEPT' ? 'Accept document' : 'Reject document'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Fetches the file with the user's token and previews it from an in-memory object URL. */
export function DocumentPreviewDialog({ open, onOpenChange, document }) {
  const [url, setUrl] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!open || !document) return undefined
    let objectUrl
    setUrl(null)
    setError(null)
    documentsService
      .download(document.id, 'inline')
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err) => setError(err.message))
    return () => objectUrl && URL.revokeObjectURL(objectUrl)
  }, [open, document])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{document?.file_name}</DialogTitle>
          <DialogDescription>Secure preview — the file is streamed through the API after an access check.</DialogDescription>
        </DialogHeader>
        <div className="flex h-[65vh] items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && !url && <p className="text-sm text-muted-foreground">Loading preview…</p>}
          {url && document?.mime_type === 'application/pdf' && <iframe src={url} title={document.file_name} className="h-full w-full bg-white" />}
          {url && document?.mime_type?.startsWith('image/') && <img src={url} alt={document.file_name} className="max-h-full max-w-full object-contain" />}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              const blob = await documentsService.download(document.id, 'attachment')
              saveBlob(blob, document.file_name)
            }}
          >
            <Download /> Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
