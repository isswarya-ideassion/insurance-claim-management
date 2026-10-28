import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ShieldAlert, UserPlus } from 'lucide-react'
import { CLAIM_TABS } from '@shared/permissions.js'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { useAuth } from '@/context/AuthContext.js'
import { ClaimStatusBadge, PriorityBadge } from '@/components/common/StatusBadge.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.js'
import { Button } from '@/components/ui/button.js'
import { TransitionActions } from './TransitionActions.js'
import { AssignDialog } from './AssignDialog.js'
import { OverviewTab } from './workspace/OverviewTab.js'
import { PolicyTab } from './workspace/PolicyTab.js'
import { DocumentsTab } from './workspace/DocumentsTab.js'
import { InvestigationTab } from './workspace/InvestigationTab.js'
import { TasksTab } from './workspace/TasksTab.js'
import { ApprovalsTab, PaymentsTab, ReservesTab } from './workspace/FinancialTabs.js'
import { ComplianceTab } from './workspace/ComplianceTab.js'
import { ActivityTab } from './workspace/ActivityTab.js'
import { AutomationTab } from './workspace/AutomationTab.js'
import { RecoveryTab } from './workspace/RecoveryTab.js'
import { formatMoney, formatRelative } from '@/utils/format.js'

const TAB_COMPONENTS = {
  overview: OverviewTab,
  policy: PolicyTab,
  documents: DocumentsTab,
  investigation: InvestigationTab,
  tasks: TasksTab,
  reserves: ReservesTab,
  approvals: ApprovalsTab,
  compliance: ComplianceTab,
  payments: PaymentsTab,
  recovery: RecoveryTab,
  automation: AutomationTab,
  activity: ActivityTab,
}

export function ClaimWorkspace({ detail, reload }) {
  const { claim } = detail
  const { can, user } = useAuth()
  const [params, setParams] = useSearchParams()
  const [assignOpen, setAssignOpen] = useState(false)
  const tabs = CLAIM_TABS.filter((t) => detail.permissions.tabs.includes(t.key))
  const active = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : tabs[0]?.key
  const ownClaim = claim.customer_id === user.id
  const canAssign = !ownClaim && (can('claims.assign') || can('claims.assignAdjuster')) && !['CLOSED', 'WITHDRAWN', 'REJECTED', 'DRAFT', 'PAID'].includes(claim.status)

  return (
    <div>
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{claim.claim_number}</h1>
              <ClaimStatusBadge status={claim.status} />
              <PriorityBadge value={claim.priority} />
              {detail.complianceHold && (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                  <ShieldAlert className="size-3" /> Compliance hold
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {POLICY_TYPE_LABELS[claim.claim_type]} · {detail.policy?.external_policy_no} · {claim.customer_name} · {formatMoney(claim.estimated_loss)}
              {claim.status === 'ON_HOLD' && claim.hold_from_status && ` · held from ${claim.hold_from_status.replaceAll('_', ' ').toLowerCase()}`}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
              <span>Owner: <strong className="font-medium text-foreground">{claim.assigned_owner_name || 'Unassigned'}</strong></span>
              <span>Reviewer: <strong className="font-medium text-foreground">{claim.assigned_reviewer_name || '—'}</strong></span>
              <span>Adjuster: <strong className="font-medium text-foreground">{claim.assigned_adjuster_name || '—'}</strong></span>
              <span className={claim.is_overdue ? 'font-medium text-red-700' : ''}>Due: {claim.due_date ? formatRelative(claim.due_date) : '—'}</span>
            </div>
          </div>
          {canAssign && (
            <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
              <UserPlus /> Assign
            </Button>
          )}
        </div>
        {!ownClaim && (
          <div className="mt-4 border-t pt-4">
            <TransitionActions claimId={claim.id} status={claim.status} version={claim.updated_at} onChanged={reload} />
          </div>
        )}
        {ownClaim && <p className="mt-4 border-t pt-4 text-sm text-amber-800">This is your own claim. Staff actions are disabled to prevent a conflict of interest.</p>}
      </div>

      <Tabs value={active} onValueChange={(tab) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', tab); return n }, { replace: true })} className="mt-6">
        <TabsList aria-label="Claim sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
              {t.key === 'documents' && detail.counts.pendingDocs > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800">{detail.counts.pendingDocs}</span>}
              {t.key === 'tasks' && detail.counts.openTasks > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px]">{detail.counts.openTasks}</span>}
              {t.key === 'compliance' && detail.complianceHold && <span className="size-1.5 rounded-full bg-red-600" aria-label="Hold active" />}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => {
          const Component = TAB_COMPONENTS[t.key]
          return (
            <TabsContent key={t.key} value={t.key}>
              {active === t.key && <Component detail={detail} reload={reload} />}
            </TabsContent>
          )
        })}
      </Tabs>

      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        claim={claim}
        defaultRole={claim.status === 'ADJUSTER_ASSIGNMENT' ? 'ADJUSTER' : ['POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW'].includes(claim.status) ? 'DOCUMENT_REVIEWER' : 'OPERATIONS_OWNER'}
        onAssigned={reload}
      />
    </div>
  )
}
