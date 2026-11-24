import { Bot, Siren } from 'lucide-react'
import { BEACON_AUTOPILOT_USER_ID } from '@shared/constants.js'
import { Badge } from '@/components/ui/badge.js'
import { Tooltip } from '@/components/ui/misc.js'
import { cn } from '@/lib/utils.js'

/** True when the Beacon AI Auto-Pilot service account made the decision. */
export const isBeaconActor = (userId) => userId === BEACON_AUTOPILOT_USER_ID

/** Subtle pill marking routine work Beacon AI completed, so reviewers can tell it apart from human exceptions. */
export function AutoHandledBadge({ title, className }) {
  return (
    <Tooltip content={title || 'Completed straight-through by Beacon AI Auto-Pilot. Every step is in the audit log.'}>
      <Badge tone="violet" className={cn('gap-1', className)}>
        <Bot className="size-3" aria-hidden="true" />
        Auto-handled by Beacon AI
      </Badge>
    </Tooltip>
  )
}

/** Marks an item Beacon AI sent to a person instead of handling it. */
export function AiEscalatedBadge({ reason, label = 'AI-escalated', className }) {
  return (
    <Tooltip content={reason || 'Beacon AI Auto-Pilot left this for a person.'}>
      <Badge tone="amber" className={cn('gap-1', className)}>
        <Siren className="size-3" aria-hidden="true" />
        {label}
      </Badge>
    </Tooltip>
  )
}
