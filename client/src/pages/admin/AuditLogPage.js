import { useState } from 'react'
import { Link } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Link2, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { ROLE_LABELS, humanize } from '@shared/constants.js'
import { auditService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Button } from '@/components/ui/button.js'
import { useListParams } from '@/hooks/useListParams.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { SearchInput } from '@/components/common/SearchInput.js'
import { EmptyState } from '@/components/common/States.js'
import { KeyValue } from '@/components/common/FormField.js'
import { Input, Label } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { SheetContent } from '@/components/ui/dialog.js'
import { formatDateTime, todayInput } from '@/utils/format.js'

const ENTITY_TYPES = ['claim', 'document', 'task', 'evaluation', 'reserve', 'review', 'payment', 'payee', 'compliance_review', 'claim_assignment', 'artifact_requirement', 'closure_request', 'recovery', 'ai_run', 'segment_config', 'user_role', 'user_attributes', 'consent', 'claim_note', 'job', 'system']

function Json({ value }) {
  if (!value || (typeof value === 'object' && Object.keys(value).length === 0)) return <span className="text-muted-foreground">—</span>
  return <pre className="max-h-64 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>
}

export default function AuditLogPage() {
  const { params, setParams } = useListParams({ pageSize: 25 })
  const query = useApiQuery(() => auditService.list(params), [JSON.stringify(params)])
  const [selected, setSelected] = useState(null)
  const { can } = useAuth()
  const action = useAction()

  async function verify() {
    const result = await action.run(() => auditService.verify())
    if (!result) return
    if (result.intact) toast.success(`Hash chain intact across ${result.rowsChecked} entries`)
    else toast.error(`Hash chain broken: ${result.problems.length} problem(s) found. Investigate immediately.`)
  }

  return (
    <MotionPage>
      <PageHeader
        title="Audit log"
        description="Append-only, hash-chained record of every change, decision, AI action and document download. Entries cannot be edited or deleted."
        actions={
          can('audit.viewAll') && (
            <Button variant="outline" onClick={verify} loading={action.pending}>
              <Link2 /> Verify hash chain
            </Button>
          )
        }
      />
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-end gap-3 border-b p-4">
          <SearchInput value={params.action || ''} onChange={(action) => setParams({ action })} placeholder="Filter by action (e.g. PAYMENT)" className="w-64" label="Action" />
          <div className="w-40"><Select aria-label="Actor type" allowClear placeholder="All actors" value={params.actorType || ''} onValueChange={(actorType) => setParams({ actorType })} options={['USER', 'AGENT', 'SYSTEM'].map((t) => ({ value: t, label: humanize(t) }))} /></div>
          <div className="w-48"><Select aria-label="Entity type" allowClear placeholder="All entities" value={params.entityType || ''} onValueChange={(entityType) => setParams({ entityType })} options={ENTITY_TYPES.map((e) => ({ value: e, label: humanize(e) }))} /></div>
          <div className="space-y-1"><Label htmlFor="a-from" className="text-xs text-muted-foreground">From</Label><Input id="a-from" type="date" max={params.to || todayInput()} value={params.from || ''} onChange={(e) => setParams({ from: e.target.value })} className="h-9 w-40" /></div>
          <div className="space-y-1"><Label htmlFor="a-to" className="text-xs text-muted-foreground">To</Label><Input id="a-to" type="date" min={params.from || undefined} max={todayInput()} value={params.to || ''} onChange={(e) => setParams({ to: e.target.value })} className="h-9 w-40" /></div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          onRowClick={setSelected}
          empty={<EmptyState icon={ScrollText} title="No audit entries match" />}
          columns={[
            { key: 'occurred_at', header: 'When', cell: (a) => <span className="whitespace-nowrap">{formatDateTime(a.occurred_at)}</span> },
            { key: 'action', header: 'Action', cell: (a) => <span className="font-medium">{humanize(a.action)}</span> },
            { key: 'actor_name', header: 'Actor', cell: (a) => <div><p>{a.actor_name || (a.actor_type === 'AGENT' ? 'AI agent' : 'System')}{a.actor_type === 'AGENT' && <span className="ml-1 rounded bg-violet-50 px-1 text-[10px] font-semibold uppercase text-violet-700">Agent</span>}</p><p className="text-xs text-muted-foreground">{a.actor_roles.map((r) => ROLE_LABELS[r] || r).join(', ')}</p></div> },
            { key: 'entity_type', header: 'Entity', cell: (a) => humanize(a.entity_type) },
            { key: 'claim_number', header: 'Claim', cell: (a) => (a.claim_id ? <Link to={`/claims/${a.claim_id}?tab=activity`} onClick={(e) => e.stopPropagation()} className="text-primary hover:underline">{a.claim_number}</Link> : '—') },
            { key: 'request_id', header: 'Request', cell: (a) => <span className="font-mono text-xs text-muted-foreground">{a.request_id?.slice(0, 8) || '—'}</span> },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} onPageSizeChange={(pageSize) => setParams({ pageSize })} />
      </div>
      <DialogPrimitive.Root open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent title={selected ? humanize(selected.action) : ''} description={selected ? `${formatDateTime(selected.occurred_at)} · #${selected.seq}` : ''}>
          {selected && (
            <div className="space-y-5 p-6">
              <KeyValue
                items={[
                  { label: 'Actor', value: `${selected.actor_name || 'System'} (${humanize(selected.actor_type)})` },
                  { label: 'Roles', value: selected.actor_roles.join(', ') || '—' },
                  { label: 'Entity', value: `${selected.entity_type}${selected.entity_id ? ` · ${selected.entity_id}` : ''}`, wide: true },
                  { label: 'Request ID', value: <span className="font-mono text-xs">{selected.request_id || '—'}</span> },
                  { label: 'IP address', value: selected.ip || '—' },
                  { label: 'Hash', value: <span className="break-all font-mono text-[11px]">{selected.hash}</span>, wide: true },
                ]}
              />
              <div><p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Before</p><Json value={selected.before} /></div>
              <div><p className="mb-1 text-xs font-medium uppercase text-muted-foreground">After</p><Json value={selected.after} /></div>
              <div><p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Metadata</p><Json value={selected.metadata} /></div>
            </div>
          )}
        </SheetContent>
      </DialogPrimitive.Root>
    </MotionPage>
  )
}
