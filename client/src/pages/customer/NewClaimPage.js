import { useParams, useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { NewClaimWizard } from '@/components/claims/NewClaimWizard.js'

export default function NewClaimPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  return (
    <MotionPage className="mx-auto max-w-4xl">
      <PageHeader
        title={id ? 'Continue your claim' : 'Start a new claim'}
        description="Your progress is saved as a draft at every step. Nothing is sent to our team until you submit."
        breadcrumbs={[{ label: 'My claims', to: '/customer/claims' }, { label: id ? 'Draft' : 'New claim' }]}
      />
      <NewClaimWizard key={id || 'new'} draftId={id} initialPolicy={params.get('policy') || ''} />
    </MotionPage>
  )
}
