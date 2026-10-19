import { useParams } from 'react-router-dom'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery } from '@/hooks/useApi.js'
import { Breadcrumbs } from '@/components/common/PageHeader.js'
import { BlockSkeleton, ErrorState } from '@/components/common/States.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { ClaimWorkspace } from '@/components/claims/ClaimWorkspace.js'

export default function ClaimDetailPage() {
  const { id } = useParams()
  const query = useApiQuery(() => claimsService.get(id), [id])

  return (
    <MotionPage>
      <Breadcrumbs items={[{ label: 'Claims', to: '/claims' }, { label: query.data?.claim.claim_number || 'Claim' }]} />
      {query.loading && !query.data && <BlockSkeleton className="h-96" />}
      {query.error && !query.data && <ErrorState error={query.error} onRetry={query.reload} title={query.error.status === 404 ? 'Claim not found or not in your scope' : undefined} />}
      {query.data && query.data.claim.view === 'staff' && <ClaimWorkspace detail={query.data} reload={query.reload} />}
      {query.data && query.data.claim.view === 'customer' && <ErrorState error={{ status: 403, message: 'This is your own claim. Open it from the customer portal.' }} />}
    </MotionPage>
  )
}
