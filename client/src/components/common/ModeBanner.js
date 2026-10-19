import { FlaskConical, ServerCrash } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'

/** Persistent indicator that the app runs in mock mode, plus a blocking warning if client and server modes disagree. */
export function ModeBanner() {
  const { appMode, serverMode, modeMismatch } = useAuth()
  if (modeMismatch) {
    return (
      <div role="alert" className="flex items-center justify-center gap-2 bg-red-700 px-4 py-1.5 text-center text-xs font-medium text-white">
        <ServerCrash className="size-3.5" aria-hidden="true" />
        Configuration mismatch: the client is in {appMode} mode but the API runs in {serverMode} mode. Sign-in is disabled until both match.
      </div>
    )
  }
  if (appMode !== 'mock') return null
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">
      <FlaskConical className="size-3.5" aria-hidden="true" />
      MOCK MODE — fictional demo data, demo logins and simulated payments. Not connected to production.
    </div>
  )
}
