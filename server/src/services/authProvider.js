import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import jwt from 'jsonwebtoken'
import { AppError, conflict, unauthorized } from '../utils/errors.js'

const scrypt = promisify(scryptCb)

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false
  const [, saltB64, hashB64] = stored.split('$')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  return timingSafeEqual(expected, actual)
}

/**
 * Supabase Auth. Tokens are issued to the browser by supabase-js (anon key)
 * and verified here with the service-role client.
 */
export async function createSupabaseAuthProvider(config) {
  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return {
    mode: 'supabase',
    admin,
    async verifyToken(token) {
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data?.user) throw unauthorized('Session is invalid or has expired')
      return { id: data.user.id, email: data.user.email }
    },
    async createUser({ email, password, fullName, phone, staff }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, phone },
        app_metadata: staff ? { provisioned_staff: true } : {},
      })
      if (error) {
        if (/already/i.test(error.message)) throw conflict('A user with this email already exists', 'USER_EXISTS')
        throw new AppError(502, 'AUTH_PROVIDER_ERROR', error.message)
      }
      return { id: data.user.id, email: data.user.email }
    },
  }
}

/**
 * MOCK MODE ONLY. Users live in the embedded database's auth.users stand-in;
 * sessions are HMAC-signed tokens. Never enabled when NODE_ENV=production
 * (enforced in config/env.js).
 */
export function createMockAuthProvider(config, db, emailService) {
  const secret = config.MOCK_AUTH_SECRET && !/change-me/.test(config.MOCK_AUTH_SECRET)
    ? config.MOCK_AUTH_SECRET
    : randomBytes(32).toString('hex')
  const issuer = 'harborpoint-mock-auth'

  const fingerprint = (hash) => createHash('sha256').update(hash || '').digest('hex').slice(0, 16)

  async function insertAuthUser({ email, password, fullName, phone, staff }) {
    const existing = await db.query('select id from auth.users where lower(email) = lower($1)', [email])
    if (existing.length) throw conflict('A user with this email already exists', 'USER_EXISTS')
    const rows = await db.query(
      `insert into auth.users (email, encrypted_password, raw_user_meta_data, raw_app_meta_data, email_confirmed_at)
       values ($1, $2, $3, $4, now()) returning id, email`,
      [
        email.toLowerCase(),
        await hashPassword(password),
        JSON.stringify({ full_name: fullName || '', phone: phone || null }),
        JSON.stringify(staff ? { provisioned_staff: true } : {}),
      ],
    )
    return rows[0]
  }

  return {
    mode: 'mock',
    async verifyToken(token) {
      try {
        const payload = jwt.verify(token, secret, { issuer, algorithms: ['HS256'] })
        if (payload.purpose !== 'session') throw new Error('wrong token purpose')
        return { id: payload.sub, email: payload.email }
      } catch {
        throw unauthorized('Session is invalid or has expired')
      }
    },
    async login(email, password) {
      const rows = await db.query(
        'select id, email, encrypted_password from auth.users where lower(email) = lower($1)',
        [email],
      )
      const user = rows[0]
      const valid = user ? await verifyPassword(password, user.encrypted_password) : false
      if (!valid) throw unauthorized('Invalid email or password')
      const expiresIn = 8 * 3600
      const accessToken = jwt.sign({ sub: user.id, email: user.email, purpose: 'session' }, secret, {
        issuer,
        expiresIn,
        algorithm: 'HS256',
      })
      return { accessToken, expiresIn, tokenType: 'bearer' }
    },
    async register({ email, password, fullName, phone }) {
      return insertAuthUser({ email, password, fullName, phone, staff: false })
    },
    async createUser({ email, password, fullName, phone, staff }) {
      return insertAuthUser({ email, password, fullName, phone, staff })
    },
    async requestPasswordReset(email, resetUrlBase) {
      const rows = await db.query('select id, email, encrypted_password from auth.users where lower(email) = lower($1)', [email])
      const user = rows[0]
      // Same response whether or not the account exists, to avoid account enumeration.
      if (!user) return { delivery: 'NOT_SENT' }
      const token = jwt.sign(
        { sub: user.id, purpose: 'reset', fp: fingerprint(user.encrypted_password) },
        secret,
        { issuer, expiresIn: 1800, algorithm: 'HS256' },
      )
      const result = await emailService.send({
        to: user.email,
        subject: 'Reset your HarborPoint password',
        text: `Use this link to reset your password (valid for 30 minutes): ${resetUrlBase}?token=${token}`,
      })
      return { delivery: result.status }
    },
    async resetPassword(token, newPassword) {
      let payload
      try {
        payload = jwt.verify(token, secret, { issuer, algorithms: ['HS256'] })
      } catch {
        throw new AppError(400, 'INVALID_RESET_TOKEN', 'Reset link is invalid or has expired')
      }
      if (payload.purpose !== 'reset') throw new AppError(400, 'INVALID_RESET_TOKEN', 'Reset link is invalid')
      const rows = await db.query('select encrypted_password from auth.users where id = $1', [payload.sub])
      if (!rows[0] || fingerprint(rows[0].encrypted_password) !== payload.fp) {
        throw new AppError(400, 'INVALID_RESET_TOKEN', 'Reset link has already been used')
      }
      await db.query('update auth.users set encrypted_password = $2 where id = $1', [
        payload.sub,
        await hashPassword(newPassword),
      ])
      return { reset: true }
    },
  }
}
