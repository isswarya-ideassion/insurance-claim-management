import { useEffect, useState } from 'react'
import { claimsService } from '@/services/claimsService.js'
import { useAction } from '@/hooks/useApi.js'
import { useAuth } from '@/context/AuthContext.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { Button } from '@/components/ui/button.js'
import { Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { FormField } from '@/components/common/FormField.js'

const ROLE_OPTIONS = [
  { value: 'OPERATIONS_OWNER', label: 'Operations owner', userRole: 'CLAIMS_OPERATIONS', permission: 'claims.assign' },
  { value: 'DOCUMENT_REVIEWER', label: 'Document reviewer', userRole: 'DOCUMENT_REVIEWER', permission: 'claims.assign' },
  { value: 'ADJUSTER', label: 'Adjuster', userRole: 'CLAIMS_ADJUSTER', permission: 'claims.assignAdjuster' },
]

export function AssignDialog({ open, onOpenChange, claim, defaultRole = 'ADJUSTER', onAssigned }) {
  const { can } = useAuth()
  const roles = ROLE_OPTIONS.filter((r) => can(r.permission))
  const [role, setRole] = useState(defaultRole)
  const [assignees, setAssignees] = useState([])
  const [assigneeId, setAssigneeId] = useState('')
  const [reason, setReason] = useState('')
  const action = useAction()

  const currentId = { OPERATIONS_OWNER: claim?.assigned_owner_id, DOCUMENT_REVIEWER: claim?.assigned_reviewer_id, ADJUSTER: claim?.assigned_adjuster_id }[role]
  const reassigning = Boolean(currentId)

  useEffect(() => {
    if (open) {
      setRole(roles.some((r) => r.value === defaultRole) ? defaultRole : roles[0]?.value)
      setReason('')
      setAssigneeId('')
    }
  }, [open])

  useEffect(() => {
    const userRole = ROLE_OPTIONS.find((r) => r.value === role)?.userRole
    if (!open || !userRole) return
    claimsService
      .assignees(userRole)
      .then((list) => setAssignees(list.filter((u) => u.id !== claim?.customer_id)))
      .catch(() => setAssignees([]))
  }, [role, open, claim?.customer_id])

  async function submit() {
    const result = await action.run(() => claimsService.assign(claim.id, { assigneeId, assignmentRole: role, reason: reason || undefined }), { success: 'Assignment saved' })
    if (result) {
      onAssigned?.(result)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reassigning ? 'Reassign claim' : 'Assign claim'}</DialogTitle>
          <DialogDescription>Workload shows each person&apos;s currently active claims. Assignees are notified.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Assignment role" required>
            <Select value={role} onValueChange={setRole} options={roles.map((r) => ({ value: r.value, label: r.label }))} />
          </FormField>
          <FormField label="Assignee" required>
            <Select
              value={assigneeId}
              onValueChange={setAssigneeId}
              placeholder="Select a person"
              options={assignees.map((u) => ({
                value: u.id,
                label: `${u.full_name} — ${u.active_claims} active${u.id === currentId ? ' (current)' : ''}`,
              }))}
            />
          </FormField>
          <FormField label={reassigning ? 'Reason for reassignment' : 'Note (optional)'} required={reassigning}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reassigning ? 'e.g. Workload balancing, specialist expertise' : ''} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={action.pending} disabled={!assigneeId || assigneeId === currentId || (reassigning && reason.trim().length < 3)}>
            {reassigning ? 'Reassign' : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
