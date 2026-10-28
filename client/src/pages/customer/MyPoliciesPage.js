import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Car, FilePlus2, HeartPulse, Home, Plane, Scale, ShieldCheck } from 'lucide-react'
import { POLICY_TYPE_LABELS } from '@shared/constants.js'
import { policiesService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { EmptyState, QueryState, CardsSkeleton } from '@/components/common/States.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { KeyValue } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { formatDate, formatMoney } from '@/utils/format.js'

const ICONS = { MOTOR: Car, PROPERTY: Home, HEALTH: HeartPulse, TRAVEL: Plane, LIABILITY: Scale }

export default function MyPoliciesPage() {
  const query = useApiQuery(() => policiesService.list({ pageSize: 100 }), [])
  return (
    <MotionPage>
      <PageHeader title="My policies" description="Policies linked to your account. Claims can only be made against active policies." />
      <QueryState query={query} skeleton={<CardsSkeleton count={3} />} empty={<EmptyState icon={ShieldCheck} title="No policies linked" description="Contact HarborPoint to link your policies to this account." />}>
        {(rows) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {rows.map((p, i) => {
              const Icon = ICONS[p.policy_type] || ShieldCheck
              return (
                <motion.article key={p.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} className="rounded-xl border bg-card p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 items-center justify-center rounded-lg bg-teal-50 text-teal-700"><Icon className="size-5" aria-hidden="true" /></div>
                      <div>
                        <h2 className="font-semibold">{p.policy_number}</h2>
                        <p className="text-sm text-muted-foreground">{POLICY_TYPE_LABELS[p.policy_type]}</p>
                      </div>
                    </div>
                    <StatusBadge value={p.status} />
                  </div>
                  <KeyValue
                    className="mt-4"
                    items={[
                      { label: 'Insured', value: p.insured_name },
                      { label: 'Covered asset', value: p.insured_asset },
                      { label: 'Period', value: `${formatDate(p.effective_from)} – ${formatDate(p.effective_to)}` },
                      { label: 'Sum insured', value: formatMoney(p.sum_insured) },
                      { label: 'Deductible', value: formatMoney(p.deductible) },
                      { label: 'Claims made', value: p.claims_count },
                    ]}
                  />
                  <div className="mt-4 flex justify-end border-t pt-4">
                    {p.status === 'ACTIVE' ? (
                      <Button asChild size="sm"><Link to={`/customer/claims/new?policy=${encodeURIComponent(p.policy_number)}`}><FilePlus2 /> Start a claim</Link></Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">This policy is {p.status.toLowerCase()} — new claims cannot be made.</p>
                    )}
                  </div>
                </motion.article>
              )
            })}
          </div>
        )}
      </QueryState>
    </MotionPage>
  )
}
