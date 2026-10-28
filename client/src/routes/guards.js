import { Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'
import { ROLE_HOME } from '@/constants/navigation.js'

export function FullPageLoader({ label = 'Loading…' }) {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </div>
  )
}

/** Requires a session and, optionally, one of the given roles (any authorized role, not just the active one). */
export function ProtectedRoute({ roles, children }) {
  const { status, user } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageLoader label="Checking your session…" />
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location }} />
  if (roles && !user.roles.some((r) => roles.includes(r))) return <Navigate to="/unauthorized" replace />
  return children
}

export function PublicOnlyRoute({ children }) {
  const { status } = useAuth()
  if (status === 'loading') return <FullPageLoader />
  if (status === 'authenticated') return <Navigate to="/" replace />
  return children
}

export function RoleHomeRedirect() {
  const { status, activeRole } = useAuth()
  if (status === 'loading') return <FullPageLoader />
  if (status !== 'authenticated') return <Navigate to="/login" replace />
  return <Navigate to={ROLE_HOME[activeRole] || '/unauthorized'} replace />
}
