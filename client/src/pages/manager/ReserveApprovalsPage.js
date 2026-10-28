import { approvalsService } from '@/services/workflowService.js'
import { ApprovalQueue } from './ApprovalQueue.js'

export default function ReserveApprovalsPage() {
  return (
    <ApprovalQueue
      kind="reserve"
      title="Reserve review queue"
      description="Reserves above the adjuster's authority. Approving or modifying moves the claim to compliance review; returning sends the evaluation back for correction."
      load={approvalsService.reserveQueue}
      decide={approvalsService.reviewReserve}
    />
  )
}
