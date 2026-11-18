import { ServerCrash } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'

/**
 * Warning when the API cannot be reached. (Demo mode is no longer announced
 * in a banner; Users & roles → System still shows "PostgreSQL · demo data".)
 */
export function ModeBanner() {
  const { serverUnreachable } = useAuth()
  if (serverUnreachable) {
    return (
      <div role="alert" className="flex items-center justify-center gap-2 bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white">
        <ServerCrash className="size-3.5" aria-hidden="true" />
        Cannot reach the claims API. Check that the server is running and its database is available.
      </div>
    )
  }
  return null
}
