import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ClaimStatusBadge } from '@/components/common/StatusBadge.js'
import { DataTable } from '@/components/common/DataTable.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { claimFormSchema, toDraftPayload, stepForField } from '@/schemas/claimSchemas.js'

const authState = { status: 'authenticated', user: { roles: ['CLAIMS_ADJUSTER'] }, activeRole: 'CLAIMS_ADJUSTER' }
vi.mock('@/context/AuthContext.js', () => ({ useAuth: () => authState }))
const { ProtectedRoute, RoleHomeRedirect } = await import('@/routes/guards.js')

function renderAt(path, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<RoleHomeRedirect />} />
        <Route path="/secure" element={element} />
        <Route path="/adjuster" element={<p>adjuster home</p>} />
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/unauthorized" element={<p>unauthorized page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('route guards', () => {
  it('redirects users without a permitted role to /unauthorized', () => {
    renderAt('/secure', <ProtectedRoute roles={['CLAIMS_MANAGER']}><p>secret</p></ProtectedRoute>)
    expect(screen.getByText('unauthorized page')).toBeInTheDocument()
  })

  it('renders content for a permitted role', () => {
    renderAt('/secure', <ProtectedRoute roles={['CLAIMS_ADJUSTER']}><p>secret</p></ProtectedRoute>)
    expect(screen.getByText('secret')).toBeInTheDocument()
  })

  it('sends anonymous users to the login page', () => {
    authState.status = 'anonymous'
    renderAt('/secure', <ProtectedRoute><p>secret</p></ProtectedRoute>)
    expect(screen.getByText('login page')).toBeInTheDocument()
    authState.status = 'authenticated'
  })

  it('redirects to the active role’s home', () => {
    renderAt('/', null)
    expect(screen.getByText('adjuster home')).toBeInTheDocument()
  })
})

describe('status badges', () => {
  it('never reveals internal hold or compliance stages to customers', () => {
    render(<ClaimStatusBadge status="COMPLIANCE_REVIEW" customer />)
    expect(screen.getByText('Being assessed')).toBeInTheDocument()
    render(<ClaimStatusBadge status="ON_HOLD" customer />)
    expect(screen.getByText('Under review')).toBeInTheDocument()
  })

  it('shows full labels to staff', () => {
    render(<ClaimStatusBadge status="RESERVE_APPROVAL" />)
    expect(screen.getByText('Reserve Approval')).toBeInTheDocument()
  })
})

describe('DataTable', () => {
  const columns = [
    { key: 'name', header: 'Name', sortable: true },
    { key: 'amount', header: 'Amount' },
  ]

  it('renders rows and reports sort changes', () => {
    const onSort = vi.fn()
    render(<DataTable columns={columns} rows={[{ id: 1, name: 'A', amount: 5 }]} sort={{ field: 'name', order: 'asc' }} onSortChange={onSort} />)
    expect(screen.getByText('A')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSort).toHaveBeenCalledWith('name', 'desc')
  })

  it('shows an empty state', () => {
    render(<DataTable columns={columns} rows={[]} />)
    expect(screen.getByText('No records match')).toBeInTheDocument()
  })

  it('makes clickable rows keyboard accessible', () => {
    const onRowClick = vi.fn()
    render(<DataTable columns={columns} rows={[{ id: 1, name: 'A', amount: 5 }]} onRowClick={onRowClick} />)
    fireEvent.keyDown(screen.getByText('A').closest('tr'), { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalled()
  })
})

describe('ConfirmDialog', () => {
  it('requires a reason before confirming critical actions', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true)
    render(<ConfirmDialog open onOpenChange={() => {}} title="Reject claim" requireReason onConfirm={onConfirm} confirmLabel="Reject" />)
    const button = screen.getByRole('button', { name: 'Reject' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Policy lapsed before incident' } })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Policy lapsed before incident'))
  })
})

describe('claim form schema', () => {
  it('requires the declaration and a meaningful description', () => {
    const result = claimFormSchema.safeParse({
      policyNumber: 'HP-1',
      insuredName: 'A B',
      incidentAt: '2026-01-01T10:00',
      incidentLocation: 'Somewhere',
      incidentCategory: 'THEFT',
      incidentDescription: 'short',
      estimatedLoss: 100,
      affectedAsset: 'Car',
      contactName: 'A B',
      contactPhone: '+1 555 0100',
      contactEmail: 'a@b.test',
      declarationAccepted: false,
    })
    const fields = result.error.issues.map((i) => i.path[0])
    expect(fields).toEqual(expect.arrayContaining(['incidentDescription', 'declarationAccepted']))
  })

  it('rejects future incident dates', () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    const r = claimFormSchema.shape.incidentAt.safeParse(future)
    expect(r.success).toBe(false)
  })

  it('converts empty values to null for draft saves', () => {
    const payload = toDraftPayload({ policyNumber: 'HP-1', incidentAt: '', estimatedLoss: '', contactEmail: '' }, 2)
    expect(payload).toMatchObject({ policyNumber: 'HP-1', incidentAt: null, estimatedLoss: null, contactEmail: null, draftStep: 2 })
  })

  it('maps server field errors back to wizard steps', () => {
    expect(stepForField('incidentDescription')).toBe(2)
    expect(stepForField('contactEmail')).toBe(5)
  })
})
