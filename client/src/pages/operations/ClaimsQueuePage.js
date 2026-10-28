import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { ClaimsListPanel } from '@/components/claims/ClaimsListPanel.js'
import { useAuth } from '@/context/AuthContext.js'

export default function ClaimsQueuePage() {
  const { hasRole } = useAuth()
  const fullScope = hasRole('CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'COMPLIANCE_SECURITY', 'DATA_ENGINEER')
  return (
    <MotionPage>
      <PageHeader
        title="Claims"
        description={fullScope ? 'All submitted claims. Search, filter and open the claim workspace.' : 'Claims within your authorized scope.'}
        breadcrumbs={[{ label: 'Claims' }]}
      />
      <ClaimsListPanel />
    </MotionPage>
  )
}
