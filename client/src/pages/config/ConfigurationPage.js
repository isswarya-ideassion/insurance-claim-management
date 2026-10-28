import { useEffect, useState } from 'react'
import { Check, FilePen, X } from 'lucide-react'
import { ROLE_LABELS, SEGMENTS, humanize } from '@shared/constants.js'
import { configService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { FormField, SectionCard } from '@/components/common/FormField.js'
import { DataTable } from '@/components/common/DataTable.js'
import { QueryState } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDateTime, formatMoney } from '@/utils/format.js'

const CONFIG_KEYS = ['required_artifacts', 'sla_hours', 'severity_thresholds', 'fraud_review_threshold', 'unclaimed_task_escalation_hours']

function ConfigValue({ value }) {
  if (value !== null && typeof value === 'object') {
    return (
      <ul className="space-y-0.5 text-xs">
        {Object.entries(value).map(([k, v]) => (
          <li key={k}>
            <span className="text-muted-foreground">{humanize(k)}:</span> {Array.isArray(v) ? v.map(humanize).join(', ') : String(v)}
          </li>
        ))}
      </ul>
    )
  }
  return <span className="tabular">{String(value)}</span>
}

function ProposeDialog({ open, onOpenChange, rows, onSaved }) {
  const [segment, setSegment] = useState('PERSONAL')
  const [configKey, setConfigKey] = useState('sla_hours')
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const [parseError, setParseError] = useState(null)
  const action = useAction()

  // Start from the active value so a proposal is an edit, not a blank slate.
  useEffect(() => {
    if (!open) return
    const active = rows.find((r) => r.segment === segment && r.config_key === configKey && r.status === 'ACTIVE')
    setValue(active ? JSON.stringify(active.config_value, null, 2) : '')
    setParseError(null)
  }, [open, segment, configKey, rows])

  async function submit() {
    let configValue
    try {
      configValue = JSON.parse(value)
    } catch {
      setParseError('Enter valid JSON')
      return
    }
    const result = await action.run(() => configService.propose({ segment, configKey, configValue, notes: notes || undefined }), { success: 'Change proposed; a second person must approve it' })
    if (result) {
      setNotes('')
      onOpenChange(false)
      onSaved?.()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Propose configuration change</DialogTitle>
          <DialogDescription>Changes take effect only after a different person approves them (four-eyes). The value is validated on submission.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Segment" required>
            <Select value={segment} onValueChange={setSegment} options={SEGMENTS.map((s) => ({ value: s, label: humanize(s) }))} />
          </FormField>
          <FormField label="Setting" required>
            <Select value={configKey} onValueChange={setConfigKey} options={CONFIG_KEYS.map((k) => ({ value: k, label: humanize(k) }))} />
          </FormField>
          <FormField label="Value (JSON)" required error={parseError} className="sm:col-span-2">
            <Textarea value={value} onChange={(e) => setValue(e.target.value)} className="min-h-48 font-mono text-xs" spellCheck={false} />
          </FormField>
          <FormField label="Reason for change" className="sm:col-span-2">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={submit} loading={action.pending} disabled={!value.trim()}>
            Submit proposal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ConfigurationPage() {
  const { can, user } = useAuth()
  const config = useApiQuery(() => configService.segments(), [])
  const limits = useApiQuery(() => configService.authorityLimits(), [])
  const reasons = useApiQuery(() => configService.fraudReasonCodes(), [])
  const action = useAction()
  const [proposeOpen, setProposeOpen] = useState(false)
  const [deciding, setDeciding] = useState(null)

  return (
    <MotionPage>
      <PageHeader
        title="Configuration"
        description="Segment rules (required documents, SLA targets, severity bands, fraud threshold) and monetary authority. Every change is versioned and approved by a second person."
        actions={
          can('config.propose') && (
            <Button onClick={() => setProposeOpen(true)}>
              <FilePen /> Propose change
            </Button>
          )
        }
      />
      <div className="space-y-5">
        <SectionCard title="Segment configuration" description="Active versions and proposals awaiting approval." bodyClassName="p-0">
          <QueryState query={config}>
            {(rows) => (
              <DataTable
                rows={rows}
                empty={<p className="p-4 text-sm text-muted-foreground">No configuration found.</p>}
                columns={[
                  { key: 'segment', header: 'Segment', cell: (r) => humanize(r.segment) },
                  { key: 'config_key', header: 'Setting', cell: (r) => <span className="font-medium">{humanize(r.config_key)}</span> },
                  { key: 'config_value', header: 'Value', cell: (r) => <ConfigValue value={r.config_value} /> },
                  { key: 'version', header: 'Version', className: 'tabular', cell: (r) => `v${r.version}` },
                  { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
                  {
                    key: 'proposed',
                    header: 'Proposed / approved',
                    cell: (r) => (
                      <div className="text-xs leading-tight">
                        <div>{r.proposed_by_name}</div>
                        {r.approved_by_name && <div className="text-muted-foreground">Approved by {r.approved_by_name} · {formatDateTime(r.approved_at)}</div>}
                        {r.notes && <div className="text-muted-foreground">“{r.notes}”</div>}
                      </div>
                    ),
                  },
                  {
                    key: 'actions',
                    header: <span className="sr-only">Actions</span>,
                    cell: (r) =>
                      r.status === 'PROPOSED' && can('config.approve') && r.proposed_by !== user.id ? (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="accent" onClick={() => setDeciding({ row: r, decision: 'APPROVED' })}><Check /> Approve</Button>
                          <Button size="sm" variant="outline" onClick={() => setDeciding({ row: r, decision: 'REJECTED' })}><X /> Reject</Button>
                        </div>
                      ) : null,
                  },
                ]}
              />
            )}
          </QueryState>
        </SectionCard>

        <div className="grid gap-5 xl:grid-cols-2">
          <SectionCard title="Authority limits" description="Role defaults per segment. Individual overrides are set on the user by Compliance & Security." bodyClassName="p-0">
            <QueryState query={limits}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  columns={[
                    { key: 'limit_type', header: 'Type', cell: (r) => humanize(r.limit_type) },
                    { key: 'role', header: 'Role', cell: (r) => ROLE_LABELS[r.role] || r.role },
                    { key: 'segment', header: 'Segment', cell: (r) => humanize(r.segment) },
                    { key: 'max_amount', header: 'Up to', className: 'tabular text-right', headerClassName: 'text-right', cell: (r) => formatMoney(r.max_amount) },
                  ]}
                />
              )}
            </QueryState>
          </SectionCard>
          <SectionCard title="Fraud reason codes" description="Weighted taxonomy; open flags add their weight to the claim's fraud score (capped at 100)." bodyClassName="p-0">
            <QueryState query={reasons}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  columns={[
                    { key: 'code', header: 'Code', cell: (r) => <span className="font-medium">{humanize(r.code)}</span> },
                    { key: 'description', header: 'Description' },
                    { key: 'category', header: 'Category', cell: (r) => humanize(r.category) },
                    { key: 'weight', header: 'Weight', className: 'tabular text-right', headerClassName: 'text-right' },
                  ]}
                />
              )}
            </QueryState>
          </SectionCard>
        </div>
      </div>

      <ProposeDialog open={proposeOpen} onOpenChange={setProposeOpen} rows={config.data || []} onSaved={config.reload} />
      <ConfirmDialog
        open={Boolean(deciding)}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.decision === 'APPROVED' ? 'Approve configuration change' : 'Reject configuration change'}
        description={deciding ? `${humanize(deciding.row.segment)} · ${humanize(deciding.row.config_key)} v${deciding.row.version}. ${deciding.decision === 'APPROVED' ? 'It replaces the active version immediately.' : 'The active version stays in effect.'}` : ''}
        confirmLabel={deciding?.decision === 'APPROVED' ? 'Approve' : 'Reject'}
        onConfirm={async () => Boolean(await action.run(async () => { await configService.decide(deciding.row.id, { decision: deciding.decision }); await config.reload() }, { success: deciding?.decision === 'APPROVED' ? 'Configuration activated' : 'Proposal rejected' }))}
      />
    </MotionPage>
  )
}
