import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, Timer } from 'lucide-react'
import { REMINDER_STATUS_LABELS, REMINDER_TYPE_LABELS } from '@shared/constants.js'
import { automationService } from '@/services/automationService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { EmptyState } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { Select } from '@/components/ui/select.js'
import { ReminderDraftDialog, ReminderStatusBadge } from '@/components/automation/AutomationComponents.js'
import { formatDateTime } from '@/utils/format.js'

export default function RemindersPage() {
  const { can } = useAuth()
  const { params, setParams } = useListParams({ pageSize: 20, status: 'DRAFT' })
  const query = useApiQuery(() => automationService.reminders(params), [JSON.stringify(params)])
  const action = useAction()
  const [review, setReview] = useState(null)
  const manage = can('automation.reminders')

  return (
    <MotionPage>
      <PageHeader
        title="Reminders"
        description="Customer reminder drafts waiting for approval, and the history of automatic deadline reminders."
        actions={
          manage && (
            <Button
              variant="outline"
              loading={action.pending}
              onClick={() =>
                action.run(async () => {
                  const r = await automationService.runReminderSweep()
                  await query.reload()
                  return r
                }, { success: (r) => `Checked ${r.claimsChecked} claim(s): ${r.remindersSent} reminder(s) sent, ${r.draftsPrepared} draft(s) prepared` })
              }
            >
              <Timer /> Check deadlines now
            </Button>
          )
        }
      />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <div className="w-full sm:w-52">
            <Select aria-label="Status" allowClear placeholder="Any status" value={params.status || ''} onValueChange={(status) => setParams({ status })} options={Object.entries(REMINDER_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
          </div>
          <div className="w-full sm:w-52">
            <Select aria-label="Type" allowClear placeholder="Any type" value={params.type || ''} onValueChange={(type) => setParams({ type })} options={Object.entries(REMINDER_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          </div>
          <div className="w-full sm:w-44">
            <Select aria-label="Audience" allowClear placeholder="Any audience" value={params.audience || ''} onValueChange={(audience) => setParams({ audience })} options={[{ value: 'INTERNAL', label: 'Internal' }, { value: 'CUSTOMER', label: 'Customer' }]} />
          </div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          caption="Reminders"
          empty={<EmptyState icon={BellRing} title="No reminders match" description={params.status === 'DRAFT' ? 'No customer drafts are waiting for approval.' : 'Try another filter.'} />}
          columns={[
            { key: 'claim_number', header: 'Claim', cell: (r) => <Link to={`/claims/${r.claim_id}?tab=automation`} className="font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>{r.claim_number}</Link> },
            { key: 'reminder_type', header: 'Type', cell: (r) => REMINDER_TYPE_LABELS[r.reminder_type] },
            { key: 'recipient', header: 'To', cell: (r) => (r.audience === 'CUSTOMER' ? `${r.recipient_name} (claimant)` : r.recipient_name) },
            { key: 'title', header: 'Subject', cell: (r) => <span className="text-sm">{r.title}</span> },
            { key: 'created_at', header: 'Created', cell: (r) => <span className="text-sm">{formatDateTime(r.created_at)}<span className="block text-xs text-muted-foreground">{r.created_by_name}</span></span> },
            { key: 'status', header: 'Status', cell: (r) => <ReminderStatusBadge status={r.status} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (r) => manage && r.status === 'DRAFT' && <Button size="sm" variant="outline" onClick={() => setReview(r)}>Review</Button>,
            },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <ReminderDraftDialog reminder={review} onClose={() => setReview(null)} onDone={query.reload} />
    </MotionPage>
  )
}
