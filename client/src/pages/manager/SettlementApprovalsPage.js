import { approvalsService } from '@/services/workflowService.js'
import { ApprovalQueue } from './ApprovalQueue.js'

export default function SettlementApprovalsPage() {
  return (
    <ApprovalQueue
      kind="settlement"
      title="Settlement approval queue"
      description="Compliance-cleared settlements. Approving creates the payment request for payment operations."
      load={approvalsService.settlementQueue}
      decide={approvalsService.decideSettlement}
    />
  )
}
