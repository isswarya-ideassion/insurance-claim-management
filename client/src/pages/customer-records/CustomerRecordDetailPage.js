import { Link, useParams } from 'react-router-dom'
import { Archive, Download, Eye } from 'lucide-react'
import { POLICY_TYPE_LABELS, STATUS_LABELS, humanize } from '@shared/constants.js'
import { customersService } from '@/services/automationService.js'
import { saveBlob } from '@/services/documentsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { KeyValue, SectionCard } from '@/components/common/FormField.js'
import { BlockSkeleton, ErrorState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js'
import { formatDate, formatDateTime, formatFileSize, formatMoney } from '@/utils/format.js'

export default function CustomerRecordDetailPage() {
  const { id } = useParams()
  const { can } = useAuth()
  const query = useApiQuery(() => customersService.get(id), [id])
  const action = useAction()
  const breadcrumbs = [{ label: 'Customer records', to: '/customer-records' }, { label: query.data?.customer.full_name || 'Customer' }]

  if (query.loading && !query.data) return <MotionPage><PageHeader title="Customer record" breadcrumbs={breadcrumbs} /><BlockSkeleton /></MotionPage>
  if (query.error) return <MotionPage><PageHeader title="Customer record" breadcrumbs={breadcrumbs} /><ErrorState error={query.error} onRetry={query.reload} /></MotionPage>

  const { customer, policies, claims, documents, possibleDuplicates, retention } = query.data

  const open = async (doc, disposition) => {
    await action.run(async () => {
      const blob = await customersService.downloadDocument(customer.id, doc.id, disposition)
      if (disposition === 'inline') {
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener')
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else {
        saveBlob(blob, doc.file_name)
      }
    })
  }

  return (
    <MotionPage>
      <PageHeader title={customer.full_name || customer.email} description={customer.email} breadcrumbs={breadcrumbs}>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {customer.is_active ? <Badge tone="green" dot>Active</Badge> : <Badge tone="neutral" dot>Deactivated</Badge>}
          {customer.possible_duplicate && <Badge tone="amber">Possible duplicate</Badge>}
        </div>
      </PageHeader>

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="Customer details" className="lg:col-span-2">
          <KeyValue
            columns={3}
            items={[
              { label: 'Customer ID', value: <span className="break-all font-mono text-xs">{customer.id}</span> },
              { label: 'Phone', value: customer.phone },
              { label: 'Customer since', value: formatDate(customer.created_at) },
              { label: 'Policies', value: customer.policy_count },
              { label: 'Claims', value: `${customer.claim_count} (${customer.open_claim_count} open)` },
              { label: 'Last activity', value: formatDate(customer.last_activity_at) },
            ]}
          />
        </SectionCard>
        <SectionCard title="Retention" actions={<Archive className="size-4 text-muted-foreground" aria-hidden="true" />}>
          <p className="text-sm">Retain until <strong>{formatDate(retention.retainUntil)}</strong></p>
          <p className="mt-2 text-xs text-muted-foreground">{retention.policy}</p>
        </SectionCard>
      </div>

      {possibleDuplicates.length > 0 && (
        <SectionCard title="Possible duplicate records" description="Email addresses are unique, so these are separate accounts. Check them before merging anything outside this system." className="mt-5">
          <ul className="divide-y">
            {possibleDuplicates.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link to={`/customer-records/${d.id}`} className="font-medium text-accent hover:underline">{d.full_name}</Link>
                <span className="text-muted-foreground">{d.email} · {d.reason}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard title="Policies" className="mt-5" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Policy</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Sum insured</TableHead>
                <TableHead>Payout account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><p className="font-medium">{p.policy_number}</p><p className="text-xs text-muted-foreground">{p.insured_asset}</p></TableCell>
                  <TableCell>{POLICY_TYPE_LABELS[p.policy_type]}</TableCell>
                  <TableCell><StatusBadge value={p.status} /></TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{formatDate(p.effective_from)} – {formatDate(p.effective_to)}</TableCell>
                  <TableCell className="tabular text-right">{formatMoney(p.sum_insured)}</TableCell>
                  <TableCell className="font-mono text-xs">{p.payout_account_masked || '—'}</TableCell>
                </TableRow>
              ))}
              {policies.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No policies.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Claim history" description="Submitted claims only; drafts are not part of the official record." className="mt-5" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Claim</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead className="text-right">Estimated loss</TableHead>
                <TableHead className="text-right">Documents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {claims.map((c) => (
                <TableRow key={c.id}>
                  <TableCell><p className="font-medium">{c.claim_number}</p><p className="text-xs text-muted-foreground">{c.policy_number}</p></TableCell>
                  <TableCell><Badge tone="navy">{STATUS_LABELS[c.status] || humanize(c.status)}</Badge></TableCell>
                  <TableCell className="text-sm">{humanize(c.incident_category || '')} · {formatDate(c.incident_at)}</TableCell>
                  <TableCell className="text-sm">{formatDate(c.submitted_at)}</TableCell>
                  <TableCell className="tabular text-right">{formatMoney(c.estimated_loss)}</TableCell>
                  <TableCell className="tabular text-right">{c.document_count}</TableCell>
                </TableRow>
              ))}
              {claims.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No submitted claims.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {can('customers.viewDocuments') && documents && (
        <SectionCard title="Documents" description="Customer-submitted documents. Every download is recorded in the audit log." className="mt-5" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Claim</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Uploaded</TableHead>
                  <TableHead><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell><p className="max-w-56 truncate font-medium">{d.file_name}</p><p className="text-xs text-muted-foreground">v{d.version_no} · {formatFileSize(d.size_bytes)}</p></TableCell>
                    <TableCell>{d.claim_number}</TableCell>
                    <TableCell>{humanize(d.category)}</TableCell>
                    <TableCell><StatusBadge value={d.status} /></TableCell>
                    <TableCell className="text-sm">{formatDateTime(d.uploaded_at)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="icon-sm" variant="ghost" aria-label={`Preview ${d.file_name}`} onClick={() => open(d, 'inline')}><Eye /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Download ${d.file_name}`} onClick={() => open(d, 'attachment')}><Download /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {documents.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">No documents.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      )}
    </MotionPage>
  )
}
