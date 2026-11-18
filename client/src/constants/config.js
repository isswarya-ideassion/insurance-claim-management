const env = import.meta.env

export const API_URL = env.VITE_API_URL || '/api'

// Must match the server's MAX_UPLOAD_MB (4 on Vercel, where requests are capped at 4.5 MB).
export const MAX_UPLOAD_MB = Math.min(10, Number(env.VITE_MAX_UPLOAD_MB) || 10)

/** Default password of the seeded demo accounts (server DEMO_PASSWORD); used only by the login page's quick role switch. */
export const DEMO_PASSWORD = 'HarborDemo!2026'

export const DEMO_ACCOUNTS = [
  { label: 'Client', email: 'customer.alice@demo.harborpoint.test' },
  { label: 'Claims Operations Manager', email: 'ops.olivia@demo.harborpoint.test' },
  { label: 'Claims Ops Manager (second)', email: 'ops.omar@demo.harborpoint.test' },
  { label: 'Claims Manager', email: 'manager.maria@demo.harborpoint.test' },
  { label: 'Claims Manager (higher authority)', email: 'manager.sam@demo.harborpoint.test' },
  { label: 'Adjuster', email: 'adjuster.adam@demo.harborpoint.test' },
  { label: 'Adjuster (second)', email: 'adjuster.amara@demo.harborpoint.test' },
  { label: 'Document Reviewer', email: 'reviewer.raj@demo.harborpoint.test' },
  { label: 'Payment Operator', email: 'payments.priya@demo.harborpoint.test' },
  { label: 'Payment Operator (second)', email: 'payments.paul@demo.harborpoint.test' },
  { label: 'Data Engineer', email: 'data.dana@demo.harborpoint.test' },
  { label: 'Compliance & Security', email: 'compliance.carlos@demo.harborpoint.test' },
  { label: 'Customer Records', email: 'records.rosa@demo.harborpoint.test', to: '/customer-records' },
]
