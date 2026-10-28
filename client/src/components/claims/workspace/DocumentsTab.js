import { useState } from 'react'
import { Send, Upload } from 'lucide-react'
import { documentsService } from '@/services/documentsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { SectionCard } from '@/components/common/FormField.js'
import { QueryState, TableSkeleton } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { DocumentList, RequiredDocumentsChecklist } from '@/components/documents/DocumentList.js'
import { UploadDocumentDialog } from '@/components/documents/DocumentDialogs.js'
import { InformationRequestList, RequestInformationDialog } from '@/components/documents/InformationRequests.js'

const UPLOAD_STATUSES = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT', 'INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'REOPENED', 'ON_HOLD']

export function DocumentsTab({ detail, reload }) {
  const { claim } = detail
  const { can } = useAuth()
  const docs = useApiQuery(() => documentsService.list(claim.id), [claim.id, claim.status])
  const requests = useApiQuery(() => documentsService.claimRequests(claim.id), [claim.id, claim.status])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const canUpload = can('documents.upload') && UPLOAD_STATUSES.includes(claim.status)
  const canRequest = can('documents.requestMissing') && UPLOAD_STATUSES.includes(claim.status)

  const refreshAll = async () => {
    await Promise.all([docs.reload(), requests.reload()])
    reload()
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="Documents"
        description="Latest versions are shown; open the menu for version history."
        actions={
          canUpload && (
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload /> Upload
            </Button>
          )
        }
      >
        <div className="space-y-4">
          <RequiredDocumentsChecklist required={detail.requiredDocuments} documents={docs.data || []} exception={claim.document_exception_reason} />
          <QueryState query={docs} skeleton={<TableSkeleton rows={3} cols={3} />}>
            {(rows) => <DocumentList documents={rows} claimId={claim.id} canUpload={canUpload} onChanged={refreshAll} />}
          </QueryState>
        </div>
      </SectionCard>
      <SectionCard
        title="Missing-document & information requests"
        actions={
          canRequest && (
            <Button size="sm" variant="outline" onClick={() => setRequestOpen(true)}>
              <Send /> New request
            </Button>
          )
        }
      >
        <QueryState query={requests} skeleton={<TableSkeleton rows={2} cols={2} />}>
          {(rows) => <InformationRequestList requests={rows} claimId={claim.id} canClose={can('documents.requestMissing')} onChanged={refreshAll} />}
        </QueryState>
      </SectionCard>
      <UploadDocumentDialog open={uploadOpen} onOpenChange={setUploadOpen} claimId={claim.id} onUploaded={refreshAll} />
      <RequestInformationDialog open={requestOpen} onOpenChange={setRequestOpen} claimId={claim.id} onCreated={refreshAll} />
    </div>
  )
}
