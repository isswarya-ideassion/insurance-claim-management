import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertCircle, FilePlus2, FileText, Inbox, ShieldCheck, Wallet } from 'lucide-react'
import { claimsService, policiesService } from '@/services/claimsService.js'
import { documentsService } from '@/services/documentsService.js'
import { paymentsService } from '@/services/workflowService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { KpiCard } from '@/components/common/KpiCard.js'
import { SectionCard } from '@/components/common/FormField.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { ClaimTable } from '@/components/claims/ClaimTable.js'
import { InformationRequestList } from '@/components/documents/InformationRequests.js'
import { EmptyState } from '@/components/common/States.js'
import { Button } from '@/components/ui/button.js'
import { MaskedAmount } from '@/components/common/MaskedAmount.js'
import { CoverageIllustration } from '@/components/customer/CoverageIllustration.js'

const ACTIVE = ['SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT', 'INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'REOPENED']

export default function CustomerDashboard() {
  const { user } = useAuth()
  const claims = useApiQuery(() => claimsService.list({ pageSize: 50, sort: 'updated_at', order: 'desc' }), [])
  const policies = useApiQuery(() => policiesService.list({ pageSize: 50 }), [])
  const requests = useApiQuery(() => documentsService.requests({ status: 'REQUESTED', pageSize: 5 }), [])
  const payments = useApiQuery(() => paymentsService.mine(), [])

  const rows = claims.data || []
  const active = rows.filter((c) => ACTIVE.includes(c.status))
  const drafts = rows.filter((c) => c.status === 'DRAFT')
  const actionRequired = rows.filter((c) => c.status === 'DOCUMENTS_REQUIRED').length + (requests.meta?.total || 0)
  const paidTotal = (payments.data || []).filter((p) => ['PAID', 'RECONCILED'].includes(p.payment?.status)).reduce((s, p) => s + Number(p.payment.amount), 0)

  return (
    <MotionPage>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b2140] via-sidebar to-[#0f3d4a] p-6 text-white sm:p-8"
      >
        <div className="relative z-10 grid items-center gap-6 md:grid-cols-[1fr_auto]">
          <div className="max-w-xl">
            <p className="text-sm text-sidebar-muted">Welcome back</p>
            <h1 className="mt-1 text-2xl font-semibold text-balance sm:text-3xl">{user.fullName || user.email}</h1>
            <p className="mt-2 text-sm text-sidebar-foreground">Your cover, claims and settlements in one place. Report a loss any time and follow every step until you are paid.</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button asChild variant="accent" size="lg">
                <Link to="/customer/claims/new"><FilePlus2 /> Start a new claim</Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="border-white/25 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                <Link to="/customer/policies"><ShieldCheck /> My policies</Link>
              </Button>
            </div>
          </div>
          <CoverageIllustration className="mx-auto w-full max-w-xs md:w-80" />
        </div>
      </motion.div>

      {actionRequired > 0 && (
        <Link to="/customer/requests" className="mb-5 flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 hover:bg-amber-100">
          <AlertCircle className="size-5 shrink-0" />
          <span><strong>Action required:</strong> we need more information or documents for {actionRequired === 1 ? 'one item' : `${actionRequired} items`}.</span>
        </Link>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard index={0} label="Active claims" value={claims.data ? active.length : null} icon={FileText} tone="navy" to="/customer/claims" />
        <KpiCard index={1} label="Open requests" value={requests.meta?.total} icon={Inbox} tone="amber" to="/customer/requests" />
        <KpiCard index={2} label="Policies" value={policies.meta?.total} icon={ShieldCheck} tone="teal" to="/customer/policies" />
        <KpiCard
          index={3}
          label="Settlements paid"
          value={payments.data ? <MaskedAmount value={paidTotal} label="total settlements paid" /> : null}
          icon={Wallet}
          tone="green"
          hint={<Link to="/customer/payments" className="font-medium text-accent hover:underline">View payments</Link>}
        />
      </div>

      {drafts.length > 0 && (
        <SectionCard title="Unfinished drafts" className="mt-5">
          <ul className="space-y-2">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                <span>Draft {d.claim_type ? `(${d.claim_type.toLowerCase()})` : ''} · step {d.draft_step} of 6</span>
                <Button size="sm" variant="outline" asChild><Link to={`/customer/claims/${d.id}/edit`}>Continue</Link></Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-5">
        <SectionCard title="Recent claims" className="xl:col-span-3" bodyClassName="p-0" actions={<Button size="sm" variant="ghost" asChild><Link to="/customer/claims">View all</Link></Button>}>
          <ClaimTable
            variant="customer"
            rows={claims.data ? rows.filter((c) => c.status !== 'DRAFT').slice(0, 5) : null}
            loading={claims.loading}
            error={claims.error}
            onRetry={claims.reload}
            hideColumns={['loss_type']}
            empty={<EmptyState icon={FileText} title="No claims yet" description="When you submit a claim it will appear here." action={<Button asChild size="sm"><Link to="/customer/claims/new">Start a claim</Link></Button>} />}
          />
        </SectionCard>
        <SectionCard title="Open requests" className="xl:col-span-2">
          <InformationRequestList requests={requests.data} customer showClaim onChanged={() => { requests.reload(); claims.reload() }} />
        </SectionCard>
      </div>
    </MotionPage>
  )
}
