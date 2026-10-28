import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PERMISSIONS } from '@shared/permissions.js'

const auth = { roles: ['CLAIMS_OPS_MANAGER'] }
vi.mock('@/context/AuthContext.js', () => ({
  useAuth: () => ({
    can: (p) => (PERMISSIONS[p] || []).some((r) => auth.roles.includes(r)),
    hasRole: (...r) => r.some((x) => auth.roles.includes(x)),
  }),
}))

const triageRun = {
  id: 'run-1',
  status: 'SUCCEEDED',
  human_decision: 'PENDING',
  review_status: 'PENDING_REVIEW',
  canApply: true,
  confidence: 0.7,
  model: 'llama3.1:8b',
  created_at: '2026-10-28T10:00:00Z',
  applied_fields: null,
  result: {
    severity: 'MEDIUM',
    complexity: 2,
    fraudBand: 'MEDIUM',
    recommendedAdjuster: { id: 'u-adam', name: 'Adam Brooks', openClaims: 3 },
    candidates: [{ id: 'u-adam', name: 'Adam Brooks', openClaims: 3 }],
    routingReason: 'Lowest workload',
    rationale: 'Moderate claim',
  },
}
vi.mock('@/services/automationService.js', () => ({
  automationService: {
    agentRuns: vi.fn(async () => ({ runs: [triageRun], configured: true, disclaimer: 'AI suggestions can be wrong.' })),
    runAgent: vi.fn(),
    applyAgentRun: vi.fn(),
    discardAgentRun: vi.fn(),
  },
}))

const { TriageAgentCard, CoverageAgentCard } = await import('@/components/automation/AgentPanels.js')
const claim = { id: 'c-1', claim_number: 'HPC-2026-000105', status: 'ADJUSTER_ASSIGNMENT' }

describe('claim agent cards', () => {
  it('shows the triage suggestion with the band only, and the actions the role may take', async () => {
    auth.roles = ['CLAIMS_OPS_MANAGER']
    render(<TriageAgentCard claim={claim} />)
    expect(await screen.findByText(/Adam Brooks \(3 open claims\)/)).toBeInTheDocument()
    expect(screen.getByText('Fraud risk band')).toBeInTheDocument()
    expect(screen.queryByText('Fraud indicator')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Assign adjuster/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /fraud flag/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run again/ })).toBeInTheDocument()
  })

  it('renders nothing for a role that may not see the agent', () => {
    auth.roles = ['DOCUMENT_REVIEWER']
    const { container } = render(<CoverageAgentCard claim={claim} />)
    expect(container).toBeEmptyDOMElement()
  })
})
