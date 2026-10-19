export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}

export function maskAccount(account) {
  if (!account) return null
  const s = String(account)
  return s.length <= 4 ? '••••' : `•••• ${s.slice(-4)}`
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
