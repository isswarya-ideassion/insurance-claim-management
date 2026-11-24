import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { groupIrrelevantAlerts, groupLabel } from '@/components/automation/UnnecessaryDocumentNotice.js'
import { useDebounce, useDebouncedField } from '@/hooks/useDebounce.js'
import { useAction } from '@/hooks/useApi.js'

vi.mock('@/context/AuthContext.js', () => ({ useAuth: () => ({ can: () => true }) }))

const unrelated = (overrides) => ({
  documentId: 'd1',
  fileName: 'image _1_.png',
  docType: 'REPAIR_ESTIMATE',
  sha256: 'a'.repeat(64),
  relevance: 'IRRELEVANT',
  relevanceDetail: 'No legible bill, report or form text was found in this file.',
  evidence: ['Beacon AI found no invoice, medical, repair, or policy details matching this claim.'],
  ...overrides,
})

describe('unnecessary-document notices', () => {
  it('groups the same file filed in several slots into one notice', () => {
    const groups = groupIrrelevantAlerts([unrelated(), unrelated({ documentId: 'd2', docType: 'PROOF_OF_LOSS' })])
    expect(groups).toHaveLength(1)
    expect(groups[0].documentIds).toEqual(['d1', 'd2'])
    expect(groupLabel(groups[0])).toBe('image _1_.png (Repair Estimate, Proof Of Loss)')
  })

  it('falls back to normalised file name and evidence when there is no hash', () => {
    const groups = groupIrrelevantAlerts([unrelated({ sha256: undefined }), unrelated({ sha256: undefined, documentId: 'd2', fileName: ' IMAGE  _1_.png ', docType: 'PROOF_OF_LOSS' })])
    expect(groups).toHaveLength(1)
  })

  it('keeps different files apart', () => {
    expect(groupIrrelevantAlerts([unrelated(), unrelated({ documentId: 'd2', sha256: 'b'.repeat(64), fileName: 'cat.jpg' })])).toHaveLength(2)
  })

  it('renders one banner and one reject button for every copy', async () => {
    const { ImageForensicsAlert } = await import('@/components/automation/ImageForensicsAlert.js')
    render(<ImageForensicsAlert alerts={[unrelated(), unrelated({ documentId: 'd2', docType: 'PROOF_OF_LOSS' })]} />)
    expect(screen.getAllByRole('status', { name: /unnecessary or non-claim document/i })).toHaveLength(1)
    expect(screen.getByText(/image _1_\.png \(Repair Estimate, Proof Of Loss\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reject 2 documents/i })).toBeInTheDocument()
  })
})

describe('debounce', () => {
  afterEach(() => vi.useRealTimers())

  it('updates only after the value stops changing', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ v }) => useDebounce(v, 300), { initialProps: { v: 'a' } })
    rerender({ v: 'ab' })
    rerender({ v: 'abc' })
    act(() => vi.advanceTimersByTime(299))
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('abc')
  })

  it('commits a filter once per pause and never echoes an external change', () => {
    vi.useFakeTimers()
    const commit = vi.fn()
    const { result, rerender } = renderHook(({ v }) => useDebouncedField(v, commit, 300), { initialProps: { v: '' } })
    act(() => result.current[1]('2'))
    act(() => result.current[1]('2026-11-01'))
    act(() => vi.advanceTimersByTime(300))
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('2026-11-01')
    rerender({ v: '2026-11-01' }) // the parent stores the committed value
    rerender({ v: '' }) // then a "Reset filters" clears it from outside
    act(() => vi.advanceTimersByTime(300))
    expect(result.current[0]).toBe('')
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('useAction lock', () => {
  it('ignores a second call while the first is in flight', async () => {
    let release
    const fn = vi.fn(() => new Promise((r) => (release = r)))
    const { result } = renderHook(() => useAction({ lock: true }))
    let first
    let second
    await act(async () => {
      first = result.current.run(fn)
      second = result.current.run(fn)
    })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(await second).toBeUndefined()
    await act(async () => release('ok'))
    expect(await first).toBe('ok')
  })

  it('does not report an intentionally cancelled request as an error', async () => {
    const { result } = renderHook(() => useAction())
    let out
    await act(async () => {
      out = await result.current.run(() => Promise.reject(new DOMException('cancelled', 'AbortError')))
    })
    expect(out).toBeUndefined()
  })
})
