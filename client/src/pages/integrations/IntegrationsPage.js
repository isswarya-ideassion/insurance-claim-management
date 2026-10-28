import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Database, Link2, Plus } from 'lucide-react'
import { INTEGRATION_SOURCES, PRECEDENCE_RULES, humanize } from '@shared/constants.js'
import { integrationsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { FormField, SectionCard } from '@/components/common/FormField.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { EmptyState, QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime } from '@/utils/format.js'

const RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']

function RecordRunDialog({ open, onOpenChange, onSaved }) {
  const [form, setForm] = useState({ sourceSystem: 'POLICY_ADMIN', status: 'SUCCEEDED', recordsIn: '0', recordsFailed: '0', checkpoint: '', error: '' })
  const action = useAction()
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }))
  async function submit() {
    const result = await action.run(
      () =>
        integrationsService.recordRun({
          sourceSystem: form.sourceSystem,
          status: form.status,
          recordsIn: Number(form.recordsIn || 0),
          recordsFailed: Number(form.recordsFailed || 0),
          finishedAt: form.status === 'RUNNING' ? null : new Date().toISOString(),
          checkpoint: form.checkpoint || null,
          error: form.error || null,
        }),
      { success: 'Sync run recorded' },
    )
    if (result) {
      onOpenChange(false)
      onSaved?.()
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record sync run</DialogTitle>
          <DialogDescription>Log a pipeline run for monitoring when the job cannot report itself.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Source system" required>
            <Select value={form.sourceSystem} onValueChange={set('sourceSystem')} options={INTEGRATION_SOURCES.map((s) => ({ value: s, label: humanize(s) }))} />
          </FormField>
          <FormField label="Status" required>
            <Select value={form.status} onValueChange={set('status')} options={RUN_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
          </FormField>
          <FormField label="Records in">
            <Input type="number" min="0" value={form.recordsIn} onChange={set('recordsIn')} />
          </FormField>
          <FormField label="Records failed">
            <Input type="number" min="0" value={form.recordsFailed} onChange={set('recordsFailed')} />
          </FormField>
          <FormField label="Checkpoint" className="sm:col-span-2">
            <Input value={form.checkpoint} onChange={set('checkpoint')} placeholder="e.g. last watermark or cursor" />
          </FormField>
          <FormField label="Error" className="sm:col-span-2">
            <Input value={form.error} onChange={set('error')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={action.pending}>Record run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LinkXrefDialog({ open, onOpenChange, onSaved }) {
  const [form, setForm] = useState({ claimId: '', sourceSystem: 'LEGACY_CLAIMS', externalClaimId: '' })
  const action = useAction()
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v?.target ? v.target.value : v }))
  async function submit() {
    const result = await action.run(() => integrationsService.linkXref({ ...form, claimId: form.claimId.trim(), externalClaimId: form.externalClaimId.trim() }), { success: 'Claim linked' })
    if (result) {
      setForm({ claimId: '', sourceSystem: 'LEGACY_CLAIMS', externalClaimId: '' })
      onOpenChange(false)
      onSaved?.()
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link external claim</DialogTitle>
          <DialogDescription>Manually map a claim in a source system to its hub claim. Each external ID can be linked once.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Hub claim ID (UUID)" required>
            <Input value={form.claimId} onChange={set('claimId')} className="font-mono text-xs" />
          </FormField>
          <FormField label="Source system" required>
            <Select value={form.sourceSystem} onValueChange={set('sourceSystem')} options={INTEGRATION_SOURCES.map((s) => ({ value: s, label: humanize(s) }))} />
          </FormField>
          <FormField label="External claim ID" required>
            <Input value={form.externalClaimId} onChange={set('externalClaimId')} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={action.pending} disabled={form.claimId.trim().length < 36 || !form.externalClaimId.trim()}>
            Link claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function IntegrationsPage() {
  const { can } = useAuth()
  const manage = can('integrations.manage')
  const { params, setParams } = useListParams({ pageSize: 15 })
  const runs = useApiQuery(() => integrationsService.runs(params), [JSON.stringify(params)])
  const xref = useApiQuery(() => integrationsService.xref({ pageSize: 20 }), [])
  const precedence = useApiQuery(() => integrationsService.precedence(), [])
  const action = useAction()
  const [runOpen, setRunOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  async function changeRule(row, rule) {
    await action.run(async () => {
      await integrationsService.setPrecedence({ fieldGroup: row.field_group, sourceSystem: row.source_system, rank: row.rank, rule })
      await precedence.reload()
    }, { success: 'Precedence rule updated' })
  }

  return (
    <MotionPage>
      <PageHeader
        title="Integrations"
        description="Source-system sync runs, claim cross-references and the precedence rules that decide which system wins on conflicting data."
        actions={
          manage && (
            <>
              <Button variant="outline" onClick={() => setLinkOpen(true)}><Link2 /> Link claim</Button>
              <Button onClick={() => setRunOpen(true)}><Plus /> Record run</Button>
            </>
          )
        }
      />
      <div className="space-y-5">
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="flex flex-wrap items-center gap-3 border-b p-4">
            <p className="mr-auto text-sm font-medium">Sync runs</p>
            <div className="w-52"><Select aria-label="Source" allowClear placeholder="All sources" value={params.source || ''} onValueChange={(source) => setParams({ source })} options={INTEGRATION_SOURCES.map((s) => ({ value: s, label: humanize(s) }))} /></div>
            <div className="w-40"><Select aria-label="Status" allowClear placeholder="All statuses" value={params.status || ''} onValueChange={(status) => setParams({ status })} options={RUN_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} /></div>
          </div>
          <DataTable
            rows={runs.data}
            loading={runs.loading}
            error={runs.error}
            onRetry={runs.reload}
            empty={<EmptyState icon={Database} title="No sync runs" />}
            columns={[
              { key: 'source_system', header: 'Source', cell: (r) => humanize(r.source_system) },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
              { key: 'started_at', header: 'Started', cell: (r) => formatDateTime(r.started_at) },
              { key: 'finished_at', header: 'Finished', cell: (r) => formatDateTime(r.finished_at) },
              { key: 'records_in', header: 'Records', className: 'tabular text-right', headerClassName: 'text-right' },
              { key: 'records_failed', header: 'Failed', className: 'tabular text-right', headerClassName: 'text-right', cell: (r) => (r.records_failed ? <span className="text-red-700">{r.records_failed}</span> : 0) },
              { key: 'checkpoint', header: 'Checkpoint', cell: (r) => <span className="font-mono text-xs">{r.checkpoint || '—'}</span> },
              { key: 'error', header: 'Error', cell: (r) => (r.error ? <span className="text-xs text-red-700">{r.error}</span> : '—') },
            ]}
          />
          <Pagination meta={runs.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          <SectionCard title="Claim cross-references" description="External claim IDs mapped to hub claims (most recent)." bodyClassName="p-0">
            <QueryState query={xref}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  empty={<p className="p-4 text-sm text-muted-foreground">No cross-references.</p>}
                  columns={[
                    { key: 'claim_number', header: 'Hub claim', cell: (r) => <Link to={`/claims/${r.claim_id}`} className="text-primary hover:underline">{r.claim_number}</Link> },
                    { key: 'source_system', header: 'Source', cell: (r) => humanize(r.source_system) },
                    { key: 'external_claim_id', header: 'External ID', cell: (r) => <span className="font-mono text-xs">{r.external_claim_id}</span> },
                    { key: 'match_method', header: 'Match', cell: (r) => `${humanize(r.match_method)}${r.match_confidence != null ? ` · ${Math.round(r.match_confidence * 100)}%` : ''}` },
                    { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
                  ]}
                />
              )}
            </QueryState>
          </SectionCard>
          <SectionCard title="Source precedence" description="Which system's value wins for each field group when sources disagree." bodyClassName="p-0">
            <QueryState query={precedence}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  rowKey={(r) => `${r.field_group}:${r.source_system}`}
                  columns={[
                    { key: 'field_group', header: 'Field group', cell: (r) => humanize(r.field_group) },
                    { key: 'source_system', header: 'Source', cell: (r) => humanize(r.source_system) },
                    { key: 'rank', header: 'Rank', className: 'tabular' },
                    {
                      key: 'rule',
                      header: 'Rule',
                      cell: (r) =>
                        manage ? (
                          <div className="w-44"><Select aria-label={`Rule for ${humanize(r.field_group)}`} value={r.rule} onValueChange={(rule) => rule !== r.rule && changeRule(r, rule)} options={PRECEDENCE_RULES.map((p) => ({ value: p, label: humanize(p) }))} /></div>
                        ) : (
                          humanize(r.rule)
                        ),
                    },
                    { key: 'updated_by_name', header: 'Updated', cell: (r) => (r.updated_by_name ? `${r.updated_by_name} · ${formatDateTime(r.updated_at)}` : formatDateTime(r.updated_at)) },
                  ]}
                />
              )}
            </QueryState>
          </SectionCard>
        </div>
      </div>
      <RecordRunDialog open={runOpen} onOpenChange={setRunOpen} onSaved={runs.reload} />
      <LinkXrefDialog open={linkOpen} onOpenChange={setLinkOpen} onSaved={xref.reload} />
    </MotionPage>
  )
}
