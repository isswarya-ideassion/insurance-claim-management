const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })

/** Amount in Indian rupees for messages and notes, e.g. "₹7,800.00". */
export function formatInr(value) {
  return inr.format(Number(value || 0))
}

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}

export function maskAccount(account) {
  if (!account) return null
  const s = String(account)
  return s.length <= 4 ? '••••' : `•••• ${s.slice(-4)}`
}

/** Masked account from the stored last four digits (full numbers stay encrypted). */
export function maskLast4(last4) {
  return last4 ? `•••• ${last4}` : null
}

export function hoursFromNow(hours, from = new Date()) {
  return new Date(from.getTime() + hours * 3600_000)
}

export function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
}

export function toIso(value) {
  if (!value) return null
  return new Date(value).toISOString()
}

export function sanitizeFileName(name) {
  const base = String(name || 'document').split(/[\\/]/).pop()
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150) || 'document'
}
