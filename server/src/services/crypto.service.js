import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { AppError } from '../utils/errors.js'
import { logger } from '../config/logger.js'

const VERSION = 'v1'
// Rows converted by migration 20261022000007 carry this prefix until the API encrypts them.
const LEGACY_PREFIX = 'plain:'

/**
 * Field-level encryption for Restricted data (bank account numbers, claimant
 * contact details). AES-256-GCM with a random IV per value; the stored form is
 * "v1:<base64(iv | tag | ciphertext)>". A separate HMAC key (derived with HKDF)
 * gives deterministic hashes so duplicates can be found without decrypting.
 */
export function createFieldCrypto(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Field encryption key must be 32 bytes')
  const encKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'harborpoint-field-encryption', 32))
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'harborpoint-field-hash', 32))

  return {
    encrypt(plaintext) {
      if (plaintext === null || plaintext === undefined || plaintext === '') return null
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', encKey, iv)
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
      return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`
    },

    decrypt(stored) {
      if (!stored) return null
      if (stored.startsWith(LEGACY_PREFIX)) return stored.slice(LEGACY_PREFIX.length)
      const [version, body] = stored.split(':', 2)
      if (version !== VERSION || !body) throw new Error('Unsupported ciphertext format')
      const raw = Buffer.from(body, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', encKey, raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      try {
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
      } catch {
        throw new AppError(
          500,
          'DECRYPTION_FAILED',
          'An encrypted field could not be decrypted: FIELD_ENCRYPTION_KEY differs from the key the data was encrypted with, or the value was altered.',
        )
      }
    },

    /** Keyed hash for equality lookups (for example, the same bank account on two payees). */
    hash(value) {
      if (value === null || value === undefined || value === '') return null
      return createHmac('sha256', macKey).update(String(value)).digest('hex')
    },

    encryptJson(value) {
      return value == null ? null : this.encrypt(JSON.stringify(value))
    },

    decryptJson(stored) {
      const text = this.decrypt(stored)
      return text ? JSON.parse(text) : null
    },
  }
}

/**
 * Encrypts rows that the PRD migration left with a "plain:" marker. Runs at
 * startup; each row is updated on its own so a failure never blocks the API.
 */
export async function encryptLegacyFields(db, crypto) {
  let converted = 0
  const payees = await db.query(`select id, bank_details_encrypted from public.payees where bank_details_encrypted like 'plain:%'`)
  for (const row of payees) {
    const account = crypto.decrypt(row.bank_details_encrypted)
    await db.query(`update public.payees set bank_details_encrypted = $2, bank_details_hash = $3 where id = $1`, [
      row.id,
      crypto.encrypt(account),
      crypto.hash(account),
    ])
    converted += 1
  }
  const parties = await db.query(`select id, contact_encrypted from public.claim_parties where contact_encrypted like 'plain:%'`)
  for (const row of parties) {
    await db.query(`update public.claim_parties set contact_encrypted = $2 where id = $1`, [
      row.id,
      crypto.encrypt(crypto.decrypt(row.contact_encrypted)),
    ])
    converted += 1
  }
  if (converted) logger.info('encrypted legacy plain-text fields', { rows: converted })
  return converted
}
