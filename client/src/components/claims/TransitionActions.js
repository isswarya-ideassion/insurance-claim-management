import { useState } from 'react'
import { ArrowRight, Lock } from 'lucide-react'
import { STATUS_LABELS } from '@shared/constants.js'
import { claimsService } from '@/services/claimsService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Tooltip, Skeleton } from '@/components/ui/misc.js'

const DESTRUCTIVE = ['REJECTED', 'WITHDRAWN', 'ON_HOLD']

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
  if (options.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
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
