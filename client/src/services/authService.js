import { APP_MODE, SUPABASE_ANON_KEY, SUPABASE_URL, configurationProblem } from '@/constants/config.js'
import { api } from './apiClient.js'

const MOCK_TOKEN_KEY = 'harborpoint.mock.session'

let supabase = null
async function getSupabase() {
  if (supabase) return supabase
  const problem = configurationProblem()
  if (problem) throw new Error(problem)
  const { createClient } = await import('@supabase/supabase-js')
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  return supabase
}

function readMockSession() {
  try {
    const raw = sessionStorage.getItem(MOCK_TOKEN_KEY)
    if (!raw) return null
    const session = JSON.parse(raw)
    return session.expiresAt > Date.now() ? session : null
  } catch {
    return null
  }
}

/**
 * Authentication facade. The mode is fixed at build time by VITE_APP_MODE;
 * a failed Supabase login never falls back to mock authentication.
 */
export const authService = {
  mode: APP_MODE,

  async getAccessToken() {
    if (APP_MODE === 'mock') return readMockSession()?.accessToken || null
    const client = await getSupabase()
    const { data } = await client.auth.getSession()
    return data.session?.access_token || null
  },

  async signIn(email, password) {
    if (APP_MODE === 'mock') {
      const res = await api.post('/auth/mock/login', { email, password })
      const session = { accessToken: res.data.accessToken, expiresAt: Date.now() + res.data.expiresIn * 1000 }
      sessionStorage.setItem(MOCK_TOKEN_KEY, JSON.stringify(session))
      return session
    }
    const client = await getSupabase()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Invalid email or password' : error.message)
    return data.session
  },

  async signUp({ email, password, fullName, phone }) {
    if (APP_MODE === 'mock') {
      await api.post('/auth/mock/register', { email, password, fullName, phone })
      return { needsConfirmation: false }
    }
    const client = await getSupabase()
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, phone }, emailRedirectTo: `${window.location.origin}/login` },
    })
    if (error) throw new Error(error.message)
    return { needsConfirmation: !data.session }
  },

  async signOut() {
    if (APP_MODE === 'mock') {
      sessionStorage.removeItem(MOCK_TOKEN_KEY)
      return
    }
    const client = await getSupabase()
    await client.auth.signOut()
  },

  async requestPasswordReset(email) {
    if (APP_MODE === 'mock') {
      const res = await api.post('/auth/mock/forgot-password', { email })
      return res.data
    }
    const client = await getSupabase()
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
    if (error) throw new Error(error.message)
    return { message: 'If an account exists for this email, a reset link has been sent by Supabase Auth.' }
  },

  async resetPassword({ token, password }) {
    if (APP_MODE === 'mock') {
      await api.post('/auth/mock/reset-password', { token, password })
      return
    }
    const client = await getSupabase()
    const { error } = await client.auth.updateUser({ password })
    if (error) throw new Error(error.message)
  },

  async onAuthChange(callback) {
    if (APP_MODE === 'mock') return () => {}
    const client = await getSupabase()
    const { data } = client.auth.onAuthStateChange((event) => callback(event))
    return () => data.subscription.unsubscribe()
  },
}
