import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DateTimePicker, formatDateTime, parseDateTime } from '@/components/ui/date-time-picker.js'

describe('DateTimePicker value format', () => {
  it('round-trips the datetime-local string the form stores', () => {
    expect(parseDateTime('2026-11-20T09:05')).toEqual({ y: 2026, mo: 11, d: 20, h: 9, mi: 5 })
    expect(formatDateTime({ y: 2026, mo: 11, d: 20, h: 9, mi: 5 })).toBe('2026-11-20T09:05')
    expect(parseDateTime('')).toBeNull()
    expect(parseDateTime('20/11/2026 09:05')).toBeNull()
  })
})

describe('DateTimePicker interaction', () => {
  // Fixed max so the calendar bounds are predictable: the 15th of Nov 2026 at 12:00.
  const max = '2026-11-15T12:00'

  it('commits the chosen value only when OK is pressed', async () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="" onChange={onChange} max={max} />)
    fireEvent.click(screen.getByRole('button', { name: /select date and time/i }))
    fireEvent.click(screen.getByRole('gridcell', { name: /^10 November 2026$/ }))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toMatch(/^2026-11-10T\d{2}:\d{2}$/)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('discards the draft on Escape', async () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="2026-11-01T08:00" onChange={onChange} max={max} />)
    fireEvent.click(screen.getByRole('button', { name: /01 Nov 2026/ }))
    fireEvent.click(screen.getByRole('gridcell', { name: /^5 November 2026$/ }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('discards the draft on a click outside', async () => {
    const onChange = vi.fn()
    render(
      <div>
        <DateTimePicker value="" onChange={onChange} max={max} />
        <span>outside</span>
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /select date and time/i }))
    fireEvent.click(screen.getByRole('gridcell', { name: /^3 November 2026$/ }))
    fireEvent.mouseDown(screen.getByText('outside'))
    expect(onChange).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not allow dates after the maximum', () => {
    render(<DateTimePicker value="" onChange={() => {}} max={max} />)
    fireEvent.click(screen.getByRole('button', { name: /select date and time/i }))
    expect(screen.getByRole('gridcell', { name: /^16 November 2026$/ })).toBeDisabled()
    expect(screen.getByRole('gridcell', { name: /^15 November 2026$/ })).not.toBeDisabled()
  })

  it('Clear then OK empties the value', () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="2026-11-02T10:30" onChange={onChange} max={max} />)
    fireEvent.click(screen.getByRole('button', { name: /02 Nov 2026/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('forwards the id so a label can point at the trigger', () => {
    render(
      <>
        <label htmlFor="incident">Date and time of incident</label>
        <DateTimePicker id="incident" value="" onChange={() => {}} max={max} />
      </>,
    )
    expect(screen.getByLabelText('Date and time of incident')).toHaveAttribute('aria-haspopup', 'dialog')
  })
})
