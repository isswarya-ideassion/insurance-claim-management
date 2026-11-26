import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DateTimePicker, displayDateTime, formatDateTime, parseDateTime, to12, to24 } from '@/components/ui/date-time-picker.js'

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
    fireEvent.click(screen.getByRole('button', { name: /01-11-2026, 08:00 AM/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /02-11-2026, 10:30 AM/ }))
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

describe('9-to-24 hour conversion (Indian 12-hour clock)', () => {
  it('maps 12 AM to 00 and 12 PM to 12', () => {
    expect(to24(12, 'AM')).toBe(0)
    expect(to24(12, 'PM')).toBe(12)
  })
  it('maps 1 PM to 11 PM across to 13 to 23', () => {
    expect(to24(1, 'PM')).toBe(13)
    expect(to24(11, 'PM')).toBe(23)
  })
  it('maps morning hours unchanged', () => {
    expect(to24(1, 'AM')).toBe(1)
    expect(to24(11, 'AM')).toBe(11)
  })
  it('round-trips every hour of the day', () => {
    for (let h = 0; h < 24; h++) {
      const { hour12, period } = to12(h)
      expect(hour12).toBeGreaterThanOrEqual(1)
      expect(hour12).toBeLessThanOrEqual(12)
      expect(to24(hour12, period)).toBe(h)
    }
  })
})

describe('Indian display format', () => {
  it('shows DD-MM-YYYY, hh:mm AM/PM', () => {
    expect(displayDateTime('2026-11-25T13:58')).toBe('25-11-2026, 01:58 PM')
    expect(displayDateTime('2026-11-25T00:05')).toBe('25-11-2026, 12:05 AM')
    expect(displayDateTime('2026-11-25T12:00')).toBe('25-11-2026, 12:00 PM')
    expect(displayDateTime('')).toBeNull()
  })
  it('emits the 24-hour datetime-local value when OK is pressed', () => {
    const onChange = vi.fn()
    render(<DateTimePicker value="2026-11-25T13:58" onChange={onChange} max="2026-11-26T23:59" />)
    fireEvent.click(screen.getByRole('button', { name: /25-11-2026, 01:58 PM/ }))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onChange).toHaveBeenCalledWith('2026-11-25T13:58')
  })
})

describe('Indian 12-hour selectors and the maximum time', () => {
  it('offers hours 01 to 12 and AM/PM, and no hour above 12', () => {
    render(<DateTimePicker value="2026-11-25T13:58" onChange={() => {}} max="2026-11-26T23:59" />)
    fireEvent.click(screen.getByRole('button', { name: /25-11-2026/ }))
    const hour = screen.getByLabelText('Hour')
    expect([...hour.options].map((o) => o.value)).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)))
    expect(hour.value).toBe('1')
    expect(screen.getByLabelText('AM or PM').value).toBe('PM')
  })

  it('disables PM on the maximum day when the maximum is before noon', async () => {
    render(<DateTimePicker value="" onChange={() => {}} max="2026-11-15T09:30" />)
    fireEvent.click(screen.getByRole('button', { name: /select date and time/i }))
    fireEvent.click(screen.getByRole('gridcell', { name: /^15 November 2026$/ }))
    const period = screen.getByLabelText('AM or PM')
    expect(period.querySelector('option[value="PM"]')).toBeDisabled()
    expect(period.querySelector('option[value="AM"]')).not.toBeDisabled()
  })

  it('disables hours after the maximum time on the maximum day, in 12-hour terms', () => {
    render(<DateTimePicker value="2026-11-15T14:00" onChange={() => {}} max="2026-11-15T14:00" />)
    fireEvent.click(screen.getByRole('button', { name: /15-11-2026/ }))
    const hour = screen.getByLabelText('Hour')
    // Current period is PM and the maximum is 14:00: 02 PM is allowed, 03 PM is not.
    expect(hour.querySelector('option[value="2"]')).not.toBeDisabled()
    expect(hour.querySelector('option[value="3"]')).toBeDisabled()
  })
})
