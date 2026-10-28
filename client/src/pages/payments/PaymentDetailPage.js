import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { PaymentDetailPanel } from '@/components/payments/PaymentDetailPanel.js'

export default function PaymentDetailPage() {
  const { id } = useParams()
  return (
    <MotionPage className="max-w-4xl">
      <PageHeader title="Payment request" breadcrumbs={[{ label: 'Payments', to: '/payments' }, { label: 'Payment' }]} />
      <PaymentDetailPanel paymentId={id} />
    </MotionPage>
  )
}
