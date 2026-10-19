import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, FileSearch, UserCheck } from 'lucide-react'
import { DOCUMENT_CATEGORIES, humanize } from '@shared/constants.js'
import { documentsService } from '@/services/documentsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { ClaimStatusBadge, PriorityBadge, StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { Switch } from '@/components/ui/misc.js'
import { DocumentPreviewDialog, ReviewDocumentDialog } from '@/components/documents/DocumentDialogs.js'
import { formatDateTime, formatRelative } from '@/utils/format.js'

export default function ReviewQueuePage() {
  const { user } = useAuth()
  const { params, setParams } = useListParams({ status: 'PENDING_REVIEW' })
  const query = useApiQuery(() => documentsService.reviewQueue(params), [JSON.stringify(params)])
  const action = useAction()
  const [preview, setPreview] = useState(null)
  const [review, setReview] = useState(null)
  const pending = params.status === 'PENDING_REVIEW'

  const columns = [
    {
      key: 'file_name',
      header: 'Document',
      cell: (d) => (
        <div className="min-w-[12rem]">
          <p className="font-medium">{d.file_name}</p>
          <p className="text-xs text-muted-foreground">{humanize(d.category)} · v{d.version_no}</p>
        </div>
      ),
    },
    {
      key: 'claim_number',
      header: 'Claim',
      cell: (d) => (
        <div>
          <Link to={`/claims/${d.claim_id}?tab=documents`} className="font-medium text-primary hover:underline">{d.claim_number}</Link>
          <div className="text-xs text-muted-foreground">{d.customer_name}</div>
        </div>
      ),
    },
    { key: 'claim_status', header: 'Claim status', cell: (d) => <ClaimStatusBadge status={d.claim_status} /> },
    { key: 'claim_priority', header: 'Priority', cell: (d) => <PriorityBadge value={d.claim_priority} /> },
    { key: 'reviewer_name', header: 'Reviewer', cell: (d) => d.reviewer_name || <span className="text-muted-foreground">Unassigned</span> },
    pending
      ? { key: 'uploaded_at', header: 'Waiting', cell: (d) => <span title={formatDateTime(d.uploaded_at)}>{formatRelative(d.uploaded_at)}</span> }
      : { key: 'reviewed_at', header: 'Reviewed', cell: (d) => `${formatDateTime(d.reviewed_at)} · ${d.reviewed_by_name || ''}` },
    !pending && { key: 'status', header: 'Decision', cell: (d) => <StatusBadge value={d.status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (d) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="icon-sm" variant="ghost" onClick={() => setPreview(d)} aria-label={`Preview ${d.file_name}`}>
            <Eye />
          </Button>
          {pending && d.reviewer_id !== user.id && (
            <Button size="icon-sm" variant="ghost" aria-label="Assign to me" title="Assign to me" onClick={() => action.run(async () => { await documentsService.assignReviewer(d.id, user.id); await query.reload() }, { success: 'Assigned to you' })}>
              <UserCheck />
            </Button>
          )}
          {pending && (
            <Button size="sm" variant="accent" onClick={() => setReview(d)}>
              Review
            </Button>
          )}
        </div>
      ),
    },
  ].filter(Boolean)

  return (
    <MotionPage>
      <PageHeader title="Document review queue" description="Verify claimant documents. Rejections notify the claimant and create a follow-up task automatically." />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-48">
            <Select aria-label="Queue" value={params.status} onValueChange={(status) => setParams({ status })} options={[{ value: 'PENDING_REVIEW', label: 'Awaiting review' }, { value: 'ACCEPTED', label: 'Accepted' }, { value: 'REJECTED', label: 'Rejected' }]} />
          </div>
          <div className="w-52">
            <Select aria-label="Category" allowClear placeholder="All categories" value={params.category || ''} onValueChange={(category) => setParams({ category })} options={DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: humanize(c) }))} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={params.mine === 'true'} onCheckedChange={(v) => setParams({ mine: v ? 'true' : '' })} aria-label="Assigned to me" />
            Assigned to me
          </label>
        </div>
        <DataTable rows={query.data} columns={columns} loading={query.loading} error={query.error} onRetry={query.reload} empty={<EmptyState icon={FileSearch} title={pending ? 'Review queue is clear' : 'No documents'} description="New uploads within your scope appear here." />} />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <DocumentPreviewDialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)} document={preview} />
      <ReviewDocumentDialog open={Boolean(review)} onOpenChange={(o) => !o && setReview(null)} document={review} onReviewed={query.reload} />
    </MotionPage>
  )
}
