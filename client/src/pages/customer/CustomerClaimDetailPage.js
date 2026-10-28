import { useState } from 'react'
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Circle, FlaskConical, Upload } from 'lucide-react'
import { POLICY_TYPE_LABELS, humanize } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { documentsService } from '@/services/documentsService.js'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { Breadcrumbs } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { BlockSkeleton, ErrorState, QueryState } from '@/components/common/States.js'
import { ClaimStatusBadge } from '@/components/common/StatusBadge.js'
import { KeyValue, SectionCard } from '@/components/common/FormField.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.js'
import { Button } from '@/components/ui/button.js'
import { Timeline } from '@/components/claims/Timeline.js'
import { TransitionActions } from '@/components/claims/TransitionActions.js'
import { DocumentList, RequiredDocumentsChecklist } from '@/components/documents/DocumentList.js'
import { UploadDocumentDialog } from '@/components/documents/DocumentDialogs.js'
import { InformationRequestList } from '@/components/documents/InformationRequests.js'
import { formatDateTime, formatMoney, formatLocation } from '@/utils/format.js'
import { MaskedAmount } from '@/components/common/MaskedAmount.js'
import { cn } from '@/lib/utils.js'

const JOURNEY = [
  { label: 'Submitted', statuses: ['SUBMITTED'] },
  { label: 'Under review', statuses: ['POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT'] },
  { label: 'Assessment', statuses: ['INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW'] },
  { label: 'Settlement', statuses: ['SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED'] },
  { label: 'Paid', statuses: ['PAID'] },
  { label: 'Closed', statuses: ['CLOSED'] },
]
const UPLOAD_STATUSES = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'INVESTIGATION', 'REOPENED']

function Journey({ status }) {
  const current = JOURNEY.findIndex((j) => j.statuses.includes(status))
  if (current < 0) return null
  return (
    <ol className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Claim progress">
      {JOURNEY.map((j, i) => (
        <li key={j.label} className="flex flex-col gap-1.5">
          <span className={cn('h-1.5 rounded-full', i <= current ? 'bg-accent' : 'bg-muted')} />
          <span className={cn('flex items-center gap-1 text-xs', i === current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {i < current ? <CheckCircle2 className="size-3 text-accent" /> : <Circle className="size-3" />}
            {j.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

export default function CustomerClaimDetailPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const query = useApiQuery(() => claimsService.get(id), [id])
  const docs = useApiQuery(() => documentsService.list(id), [id])
  const requests = useApiQuery(() => documentsService.claimRequirements(id), [id])
  const timeline = useApiQuery(() => claimsService.timeline(id), [id])
  const payment = useApiQuery(() => paymentsService.claimStatus(id), [id])
  const [uploadOpen, setUploadOpen] = useState(false)
  const tab = params.get('tab') || 'overview'

  if (query.loading && !query.data) return <BlockSkeleton className="h-96" />
  if (query.error) return <ErrorState error={query.error} onRetry={query.reload} title={query.error.status === 404 ? 'Claim not found' : undefined} />
  const { claim, policy, requiredDocuments, openRequests } = query.data
  if (claim.status === 'DRAFT') return <Navigate to={`/customer/claims/${id}/edit`} replace />
  const refresh = () => Promise.all([query.reload(), docs.reload(), requests.reload(), timeline.reload()])

  return (
    <MotionPage>
      <Breadcrumbs items={[{ label: 'My claims', to: '/customer/claims' }, { label: claim.claim_number }]} />
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{claim.claim_number}</h1>
              <ClaimStatusBadge status={claim.status} customer label={claim.status_label} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {POLICY_TYPE_LABELS[claim.claim_type]} · {policy?.external_policy_no} · submitted {formatDateTime(claim.opened_at)}
            </p>
          </div>
          <TransitionActions claimId={id} status={claim.status} version={claim.updated_at} onChanged={refresh} customer />
        </div>
        <Journey status={claim.status} />
        {openRequests > 0 && (
          <button type="button" onClick={() => setParams({ tab: 'requests' })} className="mt-4 w-full rounded-lg border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-900 hover:bg-amber-100">
            We need something from you: {openRequests} open request{openRequests > 1 ? 's' : ''}. Open the Requests tab to respond.
          </button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(t) => setParams({ tab: t }, { replace: true })} className="mt-6">
        <TabsList aria-label="Claim sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="requests">Requests{openRequests > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800">{openRequests}</span>}</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="payment">Settlement & payment</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <SectionCard title="Claim details">
            <KeyValue
              items={[
                { label: 'Incident', value: `${humanize(claim.loss_type)} · ${formatDateTime(claim.loss_date)}` },
                { label: 'Location', value: formatLocation(claim) },
                { label: 'Description', value: claim.loss_description, wide: true },
                { label: 'Estimated loss', value: formatMoney(claim.estimated_loss) },
                { label: 'Affected property / asset', value: claim.affected_asset },
                { label: 'Insured name', value: claim.insured_name },
                { label: 'Contact', value: `${claim.contact_name} · ${claim.contact_phone} · ${claim.contact_email}` },
                claim.rejection_reason && { label: 'Outcome', value: claim.rejection_reason, wide: true },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="documents">
          <SectionCard
            title="Your documents"
            description="Files are stored privately. Only you and authorized HarborPoint staff can view them."
            actions={UPLOAD_STATUSES.includes(claim.status) && <Button size="sm" onClick={() => setUploadOpen(true)}><Upload /> Upload document</Button>}
          >
            <div className="space-y-4">
              <RequiredDocumentsChecklist required={requiredDocuments} documents={docs.data || []} />
              <QueryState query={docs}>{(rows) => <DocumentList documents={rows} claimId={id} customer canUpload={UPLOAD_STATUSES.includes(claim.status)} onChanged={refresh} />}</QueryState>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="requests">
          <SectionCard title="Additional information requests">
            <QueryState query={requests}>{(rows) => <InformationRequestList requests={rows} claimId={id} customer onChanged={refresh} />}</QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="timeline">
          <SectionCard title="Claim timeline">
            <QueryState query={timeline}>{(events) => <Timeline events={events} />}</QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="payment">
          <QueryState query={payment}>
            {(p) => (
              <SectionCard title="Settlement & payment status">
                {!p.settlement ? (
                  <p className="text-sm text-muted-foreground">No settlement has been approved yet. We will notify you as soon as a decision is made.</p>
                ) : (
                  <div className="space-y-4">
                    <KeyValue
                      columns={3}
                      items={[
                        { label: 'Approved settlement', value: <MaskedAmount value={p.settlement.amount} label="settlement amount" className="text-lg font-semibold" /> },
                        { label: 'Approved on', value: formatDateTime(p.settlement.approvedAt) },
                        { label: 'Payment status', value: p.payment ? p.payment.statusLabel : 'Being prepared' },
                        p.payment && { label: 'Paying to', value: <span className="font-mono">{p.payment.beneficiaryAccount}</span> },
                        p.payment?.paidAt && { label: 'Paid on', value: formatDateTime(p.payment.paidAt) },
                        p.payment?.reference && { label: 'Reference', value: p.payment.reference },
                      ]}
                    />
                    {p.payment?.isSimulated && (
                      <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                        <FlaskConical className="mt-0.5 size-4 shrink-0" /> Demonstration environment: payments are simulated and no money is transferred.
                      </p>
                    )}
                  </div>
                )}
              </SectionCard>
            )}
          </QueryState>
        </TabsContent>
      </Tabs>
      <UploadDocumentDialog open={uploadOpen} onOpenChange={setUploadOpen} claimId={id} customer onUploaded={refresh} />
    </MotionPage>
  )
}
