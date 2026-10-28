import { api } from './apiClient.js'

const SESSION_KEY = 'harborpoint.session'

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const session = JSON.parse(raw)
    return session.expiresAt > Date.now() ? session : null
  } catch {
    return null
  }
}

/**
 * Authentication against the API's own email + password sign-in. The session
 * token lives in sessionStorage, so it ends when the tab is closed.
 */
export const authService = {
  async getAccessToken() {
    return readSession()?.accessToken || null
  },

  async signIn(email, password) {
    const res = await api.post('/auth/login', { email, password })
    const session = { accessToken: res.data.accessToken, expiresAt: Date.now() + res.data.expiresIn * 1000 }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    return session
  },

  async signUp({ email, password, fullName, phone, acceptPrivacyNotice }) {
    await api.post('/auth/register', { email, password, fullName, phone, acceptPrivacyNotice })
    return { needsConfirmation: false }
  },

  async signOut() {
    sessionStorage.removeItem(SESSION_KEY)
  },

  async requestPasswordReset(email) {
    const res = await api.post('/auth/forgot-password', { email })
    return res.data
  },

  async resetPassword({ token, password }) {
    await api.post('/auth/reset-password', { token, password })
  },
}
