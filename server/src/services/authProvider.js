import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { AppError, conflict, unauthorized } from '../utils/errors.js'

const scrypt = promisify(scryptCb)

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

const isBcrypt = (stored) => /^\$2[aby]\$\d{2}\$/.test(stored || '')

/**
 * Accepts the API's scrypt hashes and the bcrypt hashes of accounts imported
 * from Supabase Auth. Returns whether the password matched and whether the
 * stored hash should be replaced with a fresh scrypt hash.
 */
async function verifyPassword(password, stored) {
  if (isBcrypt(stored)) return { valid: await bcrypt.compare(password, stored), rehash: true }
  if (!stored || !stored.startsWith('scrypt$')) return { valid: false, rehash: false }
  const [, saltB64, hashB64] = stored.split('$')
  const expected = Buffer.from(hashB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  return { valid: timingSafeEqual(expected, actual), rehash: false }
}

// Verified against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'))

/**
 * Email + password authentication against auth.users in PostgreSQL. Sessions
 * are HS256 tokens signed with AUTH_TOKEN_SECRET; password-reset tokens are
 * single-use because they embed a fingerprint of the current password hash.
 */
export function createPasswordAuthProvider(config, db, emailService) {
  const secret = config.AUTH_TOKEN_SECRET
  const issuer = 'harborpoint-claims-api'
  const sessionSeconds = Math.round(config.AUTH_TOKEN_TTL_HOURS * 3600)

  const fingerprint = (hash) => createHash('sha256').update(hash || '').digest('hex').slice(0, 16)
  const findByEmail = async (email) =>
    (await db.query('select id, email, encrypted_password from auth.users where lower(email) = lower($1)', [email]))[0]

  async function insertAuthUser({ email, password, fullName, phone, staff }) {
    if (await findByEmail(email)) throw conflict('A user with this email already exists', 'USER_EXISTS')
    try {
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
    } catch (err) {
      // Two simultaneous registrations for one email: the unique index decides.
      if (err.code === 'DUPLICATE') throw conflict('A user with this email already exists', 'USER_EXISTS')
      throw err
    }
  }

  return {
    mode: 'password',
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
      const user = await findByEmail(email)
      const { valid, rehash } = await verifyPassword(password, user ? user.encrypted_password : DUMMY_HASH)
      if (!user || !valid) throw unauthorized('Invalid email or password')
      if (rehash) {
        await db.query('update auth.users set encrypted_password = $2 where id = $1', [user.id, await hashPassword(password)])
      }
      const accessToken = jwt.sign({ sub: user.id, email: user.email, purpose: 'session' }, secret, {
        issuer,
        expiresIn: sessionSeconds,
        algorithm: 'HS256',
      })
      return { accessToken, expiresIn: sessionSeconds, tokenType: 'bearer' }
    },
    async register({ email, password, fullName, phone }) {
      return insertAuthUser({ email, password, fullName, phone, staff: false })
    },
    async createUser({ email, password, fullName, phone, staff }) {
      return insertAuthUser({ email, password, fullName, phone, staff })
    },
    async requestPasswordReset(email, resetUrlBase) {
      const user = await findByEmail(email)
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
