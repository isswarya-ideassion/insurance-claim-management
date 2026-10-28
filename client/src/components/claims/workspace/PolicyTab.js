import { CheckCircle2, XCircle } from 'lucide-react'
import { POLICY_TYPE_LABELS, humanize } from '@shared/constants.js'
import { KeyValue, SectionCard } from '@/components/common/FormField.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { EmptyState } from '@/components/common/States.js'
import { formatDate, formatMoney } from '@/utils/format.js'
import { CoverageAgentCard } from '@/components/automation/AgentPanels.js'

export function PolicyTab({ detail, reload }) {
  const { policy, eligibility, customer } = detail
  if (!policy) return <EmptyState title="No policy linked" />
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <SectionCard title={`Policy ${policy.external_policy_no}`} className="lg:col-span-2" actions={<StatusBadge value={policy.status} />}>
        <KeyValue
          items={[
            { label: 'Policy type', value: POLICY_TYPE_LABELS[policy.policy_type] },
            { label: 'Insured', value: policy.insured_name },
            { label: 'Policyholder account', value: customer ? `${customer.full_name} (${customer.email})` : '—' },
            { label: 'Insured asset', value: policy.insured_asset },
            { label: 'Effective from', value: formatDate(policy.effective_date) },
            { label: 'Effective to', value: formatDate(policy.expiry_date) },
            { label: 'Sum insured', value: formatMoney(policy.sum_insured) },
            { label: 'Deductible', value: formatMoney(policy.deductible) },
            { label: 'Annual premium', value: formatMoney(policy.premium) },
            { label: 'Payout account', value: <span className="font-mono">{policy.payout_account_masked || '—'}</span> },
            { label: 'Coverage summary', value: policy.coverage_summary, wide: true },
          ]}
        />
      </SectionCard>
      <SectionCard title="Eligibility checks" description="Evaluated live against the policy record.">
        {eligibility ? (
          <>
            <p className={`mb-3 text-sm font-medium ${eligibility.eligible ? 'text-emerald-700' : 'text-red-700'}`}>{eligibility.eligible ? 'Eligible' : 'Not eligible'}</p>
            <ul className="space-y-2">
              {Object.entries(eligibility.checks).map(([k, ok]) => (
                <li key={k} className="flex items-center gap-2 text-sm">
                  {ok ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Pass" /> : <XCircle className="size-4 text-red-600" aria-label="Fail" />}
                  {humanize(k.replace(/([A-Z])/g, '_$1'))}
                </li>
              ))}
            </ul>
            {eligibility.reasons.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-red-700">{eligibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not available.</p>
        )}
      </SectionCard>
      <div className="lg:col-span-3">
        <CoverageAgentCard claim={detail.claim} onApplied={reload} />
      </div>
    </div>
  )
}
