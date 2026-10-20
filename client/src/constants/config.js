const env = import.meta.env

export const APP_MODE = env.VITE_APP_MODE === 'supabase' ? 'supabase' : 'mock'
export const IS_MOCK = APP_MODE === 'mock'
export const API_URL = env.VITE_API_URL || '/api/v1'
export const SUPABASE_URL = env.VITE_SUPABASE_URL || ''
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || ''

const PLACEHOLDER = /your-|placeholder/i

/** Returns a configuration problem, or null when the selected mode is usable. */
export function configurationProblem() {
  if (APP_MODE === 'supabase') {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || PLACEHOLDER.test(SUPABASE_URL) || PLACEHOLDER.test(SUPABASE_ANON_KEY)) {
      return 'VITE_APP_MODE is "supabase" but VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not configured. Set them in client/.env, or set VITE_APP_MODE=mock for the local demo.'
    }
  }
  return null
}

export const DEMO_ACCOUNTS = [
  { label: 'Customer', email: 'customer.alice@demo.harborpoint.test' },
  { label: 'Claims Operations', email: 'ops.olivia@demo.harborpoint.test' },
  { label: 'Document Reviewer', email: 'reviewer.raj@demo.harborpoint.test' },
  { label: 'Claims Adjuster', email: 'adjuster.adam@demo.harborpoint.test' },
  { label: 'Claims Manager', email: 'manager.maria@demo.harborpoint.test' },
  { label: 'Senior Manager + Ops', email: 'manager.sam@demo.harborpoint.test' },
  { label: 'Payment Operations', email: 'payments.priya@demo.harborpoint.test' },
  { label: 'Compliance Officer', email: 'compliance.carlos@demo.harborpoint.test' },
  { label: 'Data Admin', email: 'admin.dana@demo.harborpoint.test' },
  { label: 'Auditor', email: 'auditor.ade@demo.harborpoint.test' },
  { label: 'Customer Records Admin', email: 'records.rosa@demo.harborpoint.test' },
]
