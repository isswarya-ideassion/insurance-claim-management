import { approvalsService } from '@/services/workflowService.js'
import { ApprovalQueue } from './ApprovalQueue.js'

export default function ReserveApprovalsPage() {
  return (
    <ApprovalQueue
      kind="reserve"
      title="Reserve approval queue"
      description="Reserve requests from adjusters. Approving moves the claim to compliance review; returning sends the assessment back for correction."
      load={approvalsService.reserveQueue}
      decide={approvalsService.decideReserve}
    />
  )
}
