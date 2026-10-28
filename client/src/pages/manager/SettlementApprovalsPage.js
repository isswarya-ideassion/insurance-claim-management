import { approvalsService } from '@/services/workflowService.js'
import { ApprovalQueue } from './ApprovalQueue.js'

export default function SettlementApprovalsPage() {
  return (
    <ApprovalQueue
      kind="settlement"
      title="Settlement approvals"
      description="Compliance-cleared settlements awaiting approval. The assigned adjuster approves within their settlement authority; larger amounts route to a Claims Manager. A Payment Operator then issues the payment."
      load={approvalsService.settlementQueue}
      decide={approvalsService.decideSettlement}
    />
  )
}
