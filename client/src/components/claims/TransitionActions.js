import { useState } from 'react'
import { ArrowRight, Clock, Lock } from 'lucide-react'
import { STATUS_LABELS } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Tooltip, Skeleton } from '@/components/ui/misc.js'

const DESTRUCTIVE = ['REJECTED', 'WITHDRAWN', 'ON_HOLD']

/** Who has the next move on this claim, and what is still missing before they can make it. */
function WaitingOn({ claimId, status, version }) {
  const query = useApiQuery(() => claimsService.nextSteps(claimId), [claimId, status, version])
  const data = query.data
  if (!data || !data.steps.length) return null
  const people = (who) => who.map((w) => (w.name ? `${w.name} (${w.label})` : w.label)).join(' or ')
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-muted/50 p-3 text-sm" role="status">
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">
        <p className="font-medium">Nothing for you to do yet. The claim is in {data.statusLabel}.</p>
        <ul className="space-y-1 text-muted-foreground">
          {data.steps.map((s) => (
            <li key={s.label}>
              <span className="text-foreground">{s.label}</span>: waiting for {people(s.who)}.
              {s.blockedBy.length > 0 && <span> Still needed: {s.blockedBy.join(' ')}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * Workflow action bar. Options and their blocking reasons come from the API's
 * central workflow service; the server re-validates every transition.
 */
export function TransitionActions({ claimId, status, version, onChanged, customer = false }) {
  const query = useApiQuery(() => claimsService.transitions(claimId), [claimId, status, version])
  const action = useAction()
  const [selected, setSelected] = useState(null)

  if (query.loading && !query.data) return <Skeleton className="h-9 w-64" />
  const options = (query.data || []).filter((t) => !customer || t.to === 'WITHDRAWN' || t.allowed)
  // No move of your own: say who has the next one and what it is waiting for, instead of an empty bar.
  if (options.length === 0) return customer ? null : <WaitingOn claimId={claimId} status={status} version={version} />
  // Only hold / deny / withdraw available: the claim's next real move belongs to someone else, so say who.
  const onlySideExits = !customer && options.every((t) => DESTRUCTIVE.includes(t.to))

  return (
    <div className="flex flex-wrap items-center gap-2">
      {onlySideExits && (
        <div className="basis-full">
          <WaitingOn claimId={claimId} status={status} version={version} />
        </div>
      )}
      {options.map((t) => {
        const blocked = !t.allowed
        const button = (
          <Button
            key={t.to}
            size="sm"
            variant={blocked ? 'outline' : DESTRUCTIVE.includes(t.to) ? 'outline' : 'accent'}
            className={DESTRUCTIVE.includes(t.to) && !blocked ? 'border-red-200 text-red-700 hover:bg-red-50' : undefined}
            disabled={blocked}
            onClick={() => setSelected(t)}
          >
            {blocked ? <Lock /> : <ArrowRight />}
            {t.label}
          </Button>
        )
        return blocked ? (
          <Tooltip key={t.to} content={t.blockedBy.map((b) => b.message).join(' ')}>
            <span tabIndex={0} aria-label={`${t.label} unavailable: ${t.blockedBy.map((b) => b.message).join(' ')}`}>
              {button}
            </span>
          </Tooltip>
        ) : (
          button
        )
      })}
      <ConfirmDialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={selected?.label}
        description={selected && `The claim will move to ${STATUS_LABELS[selected.to]}. This is recorded in the status history and audit log.`}
        confirmLabel={selected?.label}
        variant={selected && DESTRUCTIVE.includes(selected.to) ? 'destructive' : 'default'}
        requireReason={selected?.requiresReason}
        onConfirm={async (reason) => {
          const result = await action.run(() => claimsService.transition(claimId, { toStatus: selected.to, reason: reason || undefined }), {
            success: `Claim moved to ${STATUS_LABELS[selected.to]}`,
          })
          if (!result) return false
          onChanged?.(result)
          return true
        }}
      />
    </div>
  )
}
