import { useEffect, useState } from 'react'
import { Plus, Power, Scale, ShieldPlus, Timer, Trash2, UserPlus } from 'lucide-react'
import { ALL_ROLES, ROLE_LABELS, normalizeIndianMobile } from '@shared/constants.js'
import { adminService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { useAuth } from '@/context/AuthContext.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { DataTable, Pagination } from '@/components/common/DataTable.js'
import { SearchInput } from '@/components/common/SearchInput.js'
import { PhoneInput } from '@/components/common/PhoneInput.js'
import { FormField, KeyValue, SectionCard } from '@/components/common/FormField.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Checkbox } from '@/components/ui/misc.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { formatDate, formatMoney } from '@/utils/format.js'

// Roles whose monetary authority comes from authority_limits and may be overridden per user.
const LIMITED_ROLES = ['ADJUSTER', 'OPS_MANAGER', 'PAYMENT_OPERATOR']
// The Claims Operations Manager has no monetary authority: approvals stay with the Claims Manager.
const toLimit = (v) => (v === '' || v == null ? null : Number(v))

function GrantRoleDialog({ user, onClose, onDone }) {
  const [roleCode, setRoleCode] = useState('')
  const action = useAction()
  return (
    <Dialog open={Boolean(user)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant role to {user?.full_name}</DialogTitle>
          <DialogDescription>Role changes take effect on the user&apos;s next request and are audited. You cannot change your own roles.</DialogDescription>
        </DialogHeader>
        <FormField label="Role" required>
          <Select value={roleCode} onValueChange={setRoleCode} placeholder="Select role" options={ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        </FormField>
        {LIMITED_ROLES.includes(roleCode) && (
          <p className="text-xs text-muted-foreground">Monetary authority defaults to the role&apos;s authority limits for each segment. Use “Authority” on the user to set a personal override.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={action.pending}
            disabled={!roleCode}
            onClick={async () => {
              const ok = await action.run(() => adminService.grantRole(user.id, { roleCode }), { success: 'Role granted' })
              if (ok) {
                onDone()
                onClose()
              }
            }}
          >
            Grant role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AttributesDialog({ user, onClose, onDone }) {
  const [form, setForm] = useState({})
  const action = useAction()
  useEffect(() => {
    if (!user) return
    const a = user.attributes || {}
    setForm({ reserveLimit: a.reserve_limit ?? '', settlementLimit: a.settlement_limit ?? '', region: a.region || '', teamId: a.team_id || '' })
  }, [user])
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <Dialog open={Boolean(user)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Authority & attributes — {user?.full_name}</DialogTitle>
          <DialogDescription>Leave a limit empty to use the role default from the authority limits. Overrides apply to every segment and are audited.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Reserve authority (₹)"><Input type="number" min="0" value={form.reserveLimit} onChange={set('reserveLimit')} placeholder="Role default" /></FormField>
          <FormField label="Settlement authority (₹)"><Input type="number" min="0" value={form.settlementLimit} onChange={set('settlementLimit')} placeholder="Role default" /></FormField>
          <FormField label="Region"><Input value={form.region} onChange={set('region')} /></FormField>
          <FormField label="Team"><Input value={form.teamId} onChange={set('teamId')} /></FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={action.pending}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  adminService.setAttributes(user.id, {
                    reserveLimit: toLimit(form.reserveLimit),
                    settlementLimit: toLimit(form.settlementLimit),
                    region: form.region || null,
                    teamId: form.teamId || null,
                  }),
                { success: 'Attributes saved' },
              )
              if (ok) {
                onDone()
                onClose()
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateUserDialog({ open, onOpenChange, onDone }) {
  const [form, setForm] = useState({ email: '', fullName: '', phone: '', password: '', roles: [], reserveLimit: '', settlementLimit: '' })
  const action = useAction()
  const toggle = (r) => setForm((f) => ({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x) => x !== r) : [...f.roles, r] }))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>Creates an authentication account and grants the selected roles. Share the temporary password securely.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Full name" required><Input value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} /></FormField>
          <FormField label="Email" required><Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></FormField>
          <FormField label="Mobile number" hint="Optional. 10-digit Indian mobile number."><PhoneInput value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></FormField>
          <FormField label="Temporary password" required hint="10+ chars, upper, lower, number"><Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} /></FormField>
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Roles</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {ALL_ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm">
                <Checkbox checked={form.roles.includes(r)} onCheckedChange={() => toggle(r)} /> {ROLE_LABELS[r]}
              </label>
            ))}
          </div>
        </fieldset>
        {form.roles.some((r) => LIMITED_ROLES.includes(r)) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Reserve authority override (₹)" hint="Empty uses the role default"><Input type="number" min="0" value={form.reserveLimit} onChange={(e) => setForm((f) => ({ ...f, reserveLimit: e.target.value }))} /></FormField>
            <FormField label="Settlement authority override (₹)" hint="Empty uses the role default"><Input type="number" min="0" value={form.settlementLimit} onChange={(e) => setForm((f) => ({ ...f, settlementLimit: e.target.value }))} /></FormField>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            loading={action.pending}
            disabled={!form.email || form.fullName.length < 2 || form.password.length < 10 || !form.roles.length}
            onClick={async () => {
              const ok = await action.run(
                () =>
                  adminService.createUser({
                    email: form.email,
                    fullName: form.fullName,
                    phone: normalizeIndianMobile(form.phone),
                    password: form.password,
                    roles: form.roles,
                    reserveLimit: toLimit(form.reserveLimit) ?? undefined,
                    settlementLimit: toLimit(form.settlementLimit) ?? undefined,
                  }),
                { success: 'User created' },
              )
              if (ok) {
                setForm({ email: '', fullName: '', phone: '', password: '', roles: [], reserveLimit: '', settlementLimit: '' })
                onOpenChange(false)
                onDone()
              }
            }}
          >
            <UserPlus /> Create user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function UsersPage() {
  const { user: me } = useAuth()
  const { params, setParams } = useListParams()
  const query = useApiQuery(() => adminService.users(params), [JSON.stringify(params)])
  const system = useApiQuery(() => adminService.system(), [])
  const action = useAction()
  const [grantFor, setGrantFor] = useState(null)
  const [attributesFor, setAttributesFor] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [revoke, setRevoke] = useState(null)
  const [toggle, setToggle] = useState(null)

  return (
    <MotionPage>
      <PageHeader
        title="Users & roles"
        description="Grant and revoke roles and set monetary authority. Self-escalation is blocked in both the API and the database."
        actions={
          <>
            <Button variant="outline" loading={action.pending} onClick={() => action.run(() => adminService.overdueSweep(), { success: (r) => `Sweep: ${r.overdue} overdue task(s), ${r.notified} notified, ${r.sla?.escalated ?? 0} SLA escalation(s)` })}>
              <Timer /> Run overdue & SLA sweep
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus /> Create user</Button>
          </>
        }
      />
      {system.data && (
        <SectionCard title="Environment" className="mb-5">
          <KeyValue
            columns={3}
            items={[
              { label: 'Database', value: system.data.demoData ? <Badge tone="amber">PostgreSQL · demo data</Badge> : <Badge tone="green">PostgreSQL</Badge> },
              { label: 'Email adapter', value: system.data.emailAdapter === 'console' ? 'Console (development — no delivery)' : system.data.emailAdapter },
              { label: 'Payment adapter', value: `${system.data.paymentAdapter}${system.data.paymentsSimulated ? ' — simulated, no money moved' : ''}` },
            ]}
          />
        </SectionCard>
      )}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-3 border-b p-4">
          <SearchInput value={params.search || ''} onChange={(search) => setParams({ search })} placeholder="Name or email" className="w-72" />
          <div className="w-56">
            <Select aria-label="Role filter" allowClear placeholder="All roles" value={params.role || ''} onValueChange={(role) => setParams({ role })} options={ALL_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
          </div>
        </div>
        <DataTable
          rows={query.data}
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          columns={[
            { key: 'full_name', header: 'User', cell: (u) => <div><p className="font-medium">{u.full_name || '—'}{u.id === me.id && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</p><p className="text-xs text-muted-foreground">{u.email}</p></div> },
            {
              key: 'roles',
              header: 'Roles',
              cell: (u) => (
                <div className="flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <Badge key={r.roleCode} tone="navy" className="pr-1">
                      {ROLE_LABELS[r.roleCode]}
                      {u.id !== me.id && (
                        <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-blue-100" aria-label={`Revoke ${ROLE_LABELS[r.roleCode]}`} onClick={() => setRevoke({ user: u, role: r.roleCode })}>
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                </div>
              ),
            },
            {
              key: 'attributes',
              header: 'Authority',
              cell: (u) =>
                u.attributes && (u.attributes.reserve_limit != null || u.attributes.settlement_limit != null) ? (
                  <div className="text-xs leading-tight">
                    {u.attributes.reserve_limit != null && <div>Reserve {formatMoney(u.attributes.reserve_limit, { compact: true })}</div>}
                    {u.attributes.settlement_limit != null && <div>Settlement {formatMoney(u.attributes.settlement_limit, { compact: true })}</div>}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Role default</span>
                ),
            },
            { key: 'is_active', header: 'Status', cell: (u) => (u.is_active ? <Badge tone="green" dot>Active</Badge> : <Badge tone="neutral" dot>Deactivated</Badge>) },
            { key: 'created_at', header: 'Created', cell: (u) => formatDate(u.created_at) },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (u) =>
                u.id === me.id ? null : (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => setGrantFor(u)}><ShieldPlus /> Grant role</Button>
                    {u.roles.some((r) => LIMITED_ROLES.includes(r.roleCode)) && (
                      <Button size="sm" variant="ghost" onClick={() => setAttributesFor(u)}><Scale /> Authority</Button>
                    )}
                    <Button size="icon-sm" variant="ghost" aria-label={u.is_active ? 'Deactivate user' : 'Activate user'} onClick={() => setToggle(u)}><Power /></Button>
                  </div>
                ),
            },
          ]}
        />
        <Pagination meta={query.meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
      </div>
      <GrantRoleDialog user={grantFor} onClose={() => setGrantFor(null)} onDone={query.reload} />
      <AttributesDialog user={attributesFor} onClose={() => setAttributesFor(null)} onDone={query.reload} />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} onDone={query.reload} />
      <ConfirmDialog
        open={Boolean(revoke)}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={`Revoke ${revoke ? ROLE_LABELS[revoke.role] : ''}?`}
        description={`${revoke?.user.full_name} will lose this role's access immediately.`}
        variant="destructive"
        confirmLabel="Revoke role"
        onConfirm={async () => Boolean(await action.run(async () => { await adminService.revokeRole(revoke.user.id, revoke.role); await query.reload() }, { success: 'Role revoked' }))}
      />
      <ConfirmDialog
        open={Boolean(toggle)}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.is_active ? `Deactivate ${toggle?.full_name}?` : `Activate ${toggle?.full_name}?`}
        description={toggle?.is_active ? 'The user will be unable to access the system. Existing records are preserved.' : 'The user will regain access with their current roles.'}
        variant={toggle?.is_active ? 'destructive' : 'default'}
        confirmLabel={toggle?.is_active ? 'Deactivate' : 'Activate'}
        onConfirm={async () => Boolean(await action.run(async () => { await adminService.setActive(toggle.id, !toggle.is_active); await query.reload() }, { success: 'User updated' }))}
      />
    </MotionPage>
  )
}
