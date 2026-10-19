import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ROLE_PRIORITY } from '@shared/constants.js'
import { can as canPermission, hasAnyRole } from '@shared/permissions.js'
import { authService } from '@/services/authService.js'
import { api, configureApiClient } from '@/services/apiClient.js'
import { healthService } from '@/services/workflowService.js'
import { APP_MODE } from '@/constants/config.js'

const AuthContext = createContext(null)
const ACTIVE_ROLE_KEY = 'harborpoint.activeRole'

function pickDefaultRole(roles) {
  return ROLE_PRIORITY.find((r) => roles.includes(r)) || roles[0]
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState('loading')
  const [activeRole, setActiveRoleState] = useState(null)
  const [serverMode, setServerMode] = useState(null)

  const clear = useCallback(() => {
    setUser(null)
    setActiveRoleState(null)
    setStatus('anonymous')
  }, [])

  const loadProfile = useCallback(async () => {
    const token = await authService.getAccessToken()
    if (!token) {
      clear()
      return null
    }
    try {
      const res = await api.get('/auth/me')
      const profile = res.data
      setUser(profile)
      const stored = localStorage.getItem(ACTIVE_ROLE_KEY)
      setActiveRoleState(stored && profile.roles.includes(stored) ? stored : pickDefaultRole(profile.roles))
      setStatus('authenticated')
      return profile
    } catch (err) {
      await authService.signOut().catch(() => {})
      clear()
      throw err
    }
  }, [clear])

  useEffect(() => {
    configureApiClient({
      getToken: () => authService.getAccessToken(),
      onUnauthorized: () => {
        authService.signOut().catch(() => {})
        clear()
      },
    })
    healthService
      .check()
      .then((h) => setServerMode(h.mode))
      .catch(() => setServerMode('unreachable'))
    loadProfile().catch(() => {})
    let unsubscribe = () => {}
    authService
      .onAuthChange((event) => {
        if (event === 'SIGNED_OUT') clear()
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') loadProfile().catch(() => {})
      })
      .then((fn) => {
        unsubscribe = fn
      })
      .catch(() => {})
    return () => unsubscribe()
  }, [loadProfile, clear])

  const login = useCallback(
    async (email, password) => {
      await authService.signIn(email, password)
      return loadProfile()
    },
    [loadProfile],
  )

  const logout = useCallback(async () => {
    await authService.signOut().catch(() => {})
    clear()
  }, [clear])

  const setActiveRole = useCallback(
    (role) => {
      if (!user?.roles.includes(role)) return
      localStorage.setItem(ACTIVE_ROLE_KEY, role)
      setActiveRoleState(role)
    },
    [user],
  )

  const value = useMemo(
    () => ({
      user,
      status,
      roles: user?.roles || [],
      activeRole,
      setActiveRole,
      login,
      logout,
      refreshProfile: loadProfile,
      appMode: APP_MODE,
      serverMode,
      modeMismatch: Boolean(serverMode && serverMode !== 'unreachable' && serverMode !== APP_MODE),
      can: (permission) => canPermission(user?.roles || [], permission),
      hasRole: (...roles) => hasAnyRole(user?.roles || [], roles),
    }),
    [user, status, activeRole, setActiveRole, login, logout, loadProfile, serverMode],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
