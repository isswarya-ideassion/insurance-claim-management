import { FlaskConical, ServerCrash } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'

/** Persistent indicator when the API serves fictional demo data, and a warning when the API cannot be reached. */
export function ModeBanner() {
  const { demoData, serverUnreachable } = useAuth()
  if (serverUnreachable) {
    return (
      <div role="alert" className="flex items-center justify-center gap-2 bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white">
        <ServerCrash className="size-3.5" aria-hidden="true" />
        Cannot reach the claims API. Check that the server is running and its database is available.
      </div>
    )
  }
  if (!demoData) return null
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">
      <FlaskConical className="size-3.5" aria-hidden="true" />
      DEMO DATA — fictional users, policies and claims, and simulated payments.
    </div>
  )
}
