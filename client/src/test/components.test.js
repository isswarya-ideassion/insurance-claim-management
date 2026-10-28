import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ClaimStatusBadge } from '@/components/common/StatusBadge.js'
import { DataTable } from '@/components/common/DataTable.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { ErrorBoundary } from '@/components/common/ErrorBoundary.js'
import { claimFormSchema, toDraftPayload, stepForField } from '@/schemas/claimSchemas.js'

const authState = { status: 'authenticated', user: { roles: ['ADJUSTER'] }, activeRole: 'ADJUSTER' }
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
    renderAt('/secure', <ProtectedRoute roles={['OPS_MANAGER']}><p>secret</p></ProtectedRoute>)
    expect(screen.getByText('unauthorized page')).toBeInTheDocument()
  })

  it('renders content for a permitted role', () => {
    renderAt('/secure', <ProtectedRoute roles={['ADJUSTER']}><p>secret</p></ProtectedRoute>)
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
    expect(screen.getByText('Reserve Review')).toBeInTheDocument()
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
      lossDate: '2026-01-01T10:00',
      lossLocation: 'Somewhere',
      lossCity: 'Kochi',
      lossCountry: 'India',
      lossType: 'THEFT',
      lossDescription: 'short',
      estimatedLoss: 100,
      affectedAsset: 'Car',
      contactName: 'A B',
      contactPhone: '98765 43210',
      contactEmail: 'a@b.test',
      declarationAccepted: false,
    })
    const fields = result.error.issues.map((i) => i.path[0])
    expect(fields).toEqual(expect.arrayContaining(['lossDescription', 'declarationAccepted']))
  })

  it('rejects future loss dates', () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    const r = claimFormSchema.shape.lossDate.safeParse(future)
    expect(r.success).toBe(false)
  })

  it('converts empty values to null for draft saves', () => {
    const payload = toDraftPayload({ policyNumber: 'HP-1', lossDate: '', estimatedLoss: '', contactEmail: '' }, 2)
    expect(payload).toMatchObject({ policyNumber: 'HP-1', lossDate: null, estimatedLoss: null, contactEmail: null, draftStep: 2 })
  })

  it('maps server field errors back to wizard steps', () => {
    expect(stepForField('lossDescription')).toBe(2)
    expect(stepForField('lossCity')).toBe(2)
    expect(stepForField('contactEmail')).toBe(5)
  })

  it('accepts only Indian mobile numbers and sends them as +91 XXXXX XXXXX', () => {
    const phone = claimFormSchema.shape.contactPhone
    expect(phone.safeParse('98765 43210').success).toBe(true)
    expect(phone.safeParse('+1 555 0100').success).toBe(false)
    expect(phone.safeParse('12345 67890').success).toBe(false)
    expect(toDraftPayload({ contactPhone: '98765 43210' }, 5).contactPhone).toBe('+91 98765 43210')
    expect(toDraftPayload({ contactPhone: '98765' }, 5).contactPhone).toBeNull()
  })

  it('requires the loss city and country, and never sends the insured name', () => {
    const r = claimFormSchema.safeParse({})
    expect(r.error.issues.map((i) => i.path[0])).toEqual(expect.arrayContaining(['lossCity', 'lossCountry']))
    expect(toDraftPayload({ insuredName: 'Someone Else' }, 1)).not.toHaveProperty('insuredName')
  })
})

describe('phone input and claim filters', () => {
  it('keeps ten digits, dropping a pasted +91 or leading zero', async () => {
    const { formatLocalMobile } = await import('@/components/common/PhoneInput.js')
    expect(formatLocalMobile('+91 98765-43210')).toBe('98765 43210')
    expect(formatLocalMobile('098765432109')).toBe('98765 43210')
    expect(formatLocalMobile('987ab65')).toBe('98765')
  })

  it('turns a "submitted in" window into a from-date', async () => {
    const { submittedSince } = await import('@/pages/customer/MyClaimsPage.js')
    expect(submittedSince('30', new Date(2026, 9, 27, 12))).toBe('2026-09-27')
    expect(submittedSince('')).toBeUndefined()
  })
})

describe('ErrorBoundary', () => {
  function Boom({ message }) {
    throw new Error(message)
  }

  it('shows an error panel with retry instead of a blank page when a page crashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom message="rows.map is not a function" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This page ran into a problem')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    rerender(
      <ErrorBoundary resetKey="/b">
        <p>next page</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('next page')).toBeInTheDocument()
    console.error.mockRestore()
  })

  it('explains a failed lazy page load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /src/pages/NotificationsPage.js" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('This page could not be loaded')
    console.error.mockRestore()
  })
})

const { evaluationNotice } = await import('@/components/claims/workspace/InvestigationTab.js')

describe('evaluation tab notice', () => {
  const claim = (status, extra = {}) => ({ status, assigned_adjuster_name: null, ...extra })

  it('explains that evaluation has not started before investigation', () => {
    const n = evaluationNotice({ claim: claim('DOCUMENT_REVIEW'), rows: [], isAssignedAdjuster: false })
    expect(n.title).toBe('Evaluation not started yet')
    expect(n.description).toContain('Document Review')
    expect(n.description).toContain('No adjuster is assigned yet.')
  })

  it('names the adjuster while investigation is under way', () => {
    const n = evaluationNotice({ claim: claim('INVESTIGATION', { assigned_adjuster_name: 'Adam Brooks' }), rows: [], isAssignedAdjuster: false })
    expect(n.description).toContain('Adam Brooks')
  })

  it('stays out of the way when the editor or evaluations are shown', () => {
    expect(evaluationNotice({ claim: claim('INVESTIGATION'), rows: [], isAssignedAdjuster: true })).toBeNull()
    expect(evaluationNotice({ claim: claim('COMPLIANCE_REVIEW'), rows: [{ status: 'SUBMITTED' }], isAssignedAdjuster: false })).toBeNull()
  })

  it('tells the adjuster a paused draft is kept', () => {
    const n = evaluationNotice({ claim: claim('DOCUMENTS_REQUIRED'), rows: [{ status: 'DRAFT', version_no: 2 }], isAssignedAdjuster: true })
    expect(n.title).toBe('Draft v2 saved')
  })

  it('covers holds and claims ended before evaluation', () => {
    expect(evaluationNotice({ claim: claim('ON_HOLD', { hold_from_status: 'INVESTIGATION' }), rows: [], isAssignedAdjuster: false }).description).toContain('during Investigation')
    expect(evaluationNotice({ claim: claim('REJECTED'), rows: [], isAssignedAdjuster: false }).description).toBe('The claim was denied before it reached evaluation.')
  })
})
