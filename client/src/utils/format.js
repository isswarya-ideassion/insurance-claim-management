export { humanize } from '@shared/constants.js'

// Amounts are Indian rupees, grouped the Indian way (₹1,25,000.00).
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const compactCurrency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', notation: 'compact', maximumFractionDigits: 1 })
// One date style everywhere: "27 Oct 2026" and "27 Oct 2026, 5:36 pm" in the viewer's time zone.
const dateFmt = new Intl.DateTimeFormat('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function formatMoney(value, { compact = false } = {}) {
  if (value === null || value === undefined || value === '') return '—'
  return (compact ? compactCurrency : currency).format(Number(value))
}

export function formatDate(value) {
  if (!value) return '—'
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d)
}

export function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d)
}

export function formatRelative(value) {
  if (!value) return '—'
  const diff = new Date(value).getTime() - Date.now()
  const abs = Math.abs(diff)
  const units = [
    ['year', 365 * 86400000],
    ['month', 30 * 86400000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
  ]
  for (const [unit, ms] of units) {
    if (abs >= ms) return relative.format(Math.round(diff / ms), unit)
  }
  return 'just now'
}

export function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

export function toDateInput(value) {
  if (!value) return ''
  const d = new Date(value)
  return d.toISOString().slice(0, 10)
}

/** Address, city and country of a loss, as one line. */
export function formatLocation(claim) {
  return [claim?.loss_location, claim?.loss_city, claim?.loss_country].filter(Boolean).join(', ') || '—'
}

/** Today as a date input value (local time), for min/max on date pickers. */
export function todayInput() {
  return toDateTimeLocal(new Date()).slice(0, 10)
}

export function toDateTimeLocal(value) {
  if (!value) return ''
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Describes a user's monetary authority (from /auth/me limits) for one limit type, per segment. */
export function formatAuthority(limits, type) {
  const bySegment = limits?.[type]
  if (!bySegment) return 'none'
  const parts = Object.entries(bySegment)
    .filter(([, amount]) => amount != null)
    .map(([segment, amount]) => `${segment.charAt(0)}${segment.slice(1).toLowerCase()} ${formatMoney(amount)}`)
  return parts.length ? parts.join(' · ') : 'none'
}
