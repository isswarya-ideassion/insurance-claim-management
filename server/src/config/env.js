import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const flag = (fallback) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true'))

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  // PostgreSQL connection, e.g. postgresql://harborpoint:secret@localhost:5432/harborpoint
  DATABASE_URL: z.string().optional(),
  // disable | require (encrypted, certificate not checked) | verify-full (encrypted and verified)
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Apply pending migrations from database/migrations when the API starts.
  DB_MIGRATE_ON_START: flag(true),

  // Sessions are HS256 tokens signed with this secret (at least 32 characters).
  AUTH_TOKEN_SECRET: z.string().optional(),
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().min(1).max(72).default(8),

  // Fictional demo users, policies and claims. Never allowed in production.
  SEED_DEMO_DATA: flag(false),
  DEMO_PASSWORD: z.string().default('HarborDemo!2026'),

  EMAIL_ADAPTER: z.enum(['console', 'disabled']).default('console'),
  EMAIL_FROM: z.string().default('claims@harborpoint.example'),
  PAYMENT_ADAPTER: z.enum(['simulated']).default('simulated'),
  OVERDUE_SWEEP_MINUTES: z.coerce.number().min(0).default(15),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().optional(),

  // AI automation. "none" disables AI features; the API then returns setup
  // instructions instead of results. Credentials stay server-side.
  AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(90_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  // Field-level encryption for bank details and claimant contact data
  // (AES-256-GCM). 32 bytes, base64 or hex.
  FIELD_ENCRYPTION_KEY: z.string().optional(),

  // Rule-based reminders and record retention.
  REMINDER_LEAD_HOURS: z.coerce.number().min(1).max(24 * 14).default(24),
  CUSTOMER_RECORD_RETENTION_YEARS: z.coerce.number().int().min(1).max(100).default(7),
})

const PLACEHOLDER = /your-|change-me|placeholder/i
// Demo and test databases hold only fictional data, so they may use this fixed key.
const DEV_ENCRYPTION_KEY = Buffer.from('harborpoint-dev-only-field-key!!', 'utf8')

function parseEncryptionKey(value) {
  if (!value || PLACEHOLDER.test(value)) return null
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')
  return key.length === 32 ? key : null
}

export function loadConfig(overrides = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides })
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid server configuration: ${issues}`)
  }
  const env = parsed.data
  const isProduction = env.NODE_ENV === 'production'
  const isTest = env.NODE_ENV === 'test'

  if (!env.DATABASE_URL || PLACEHOLDER.test(env.DATABASE_URL)) {
    throw new Error('DATABASE_URL is required: the PostgreSQL connection string, e.g. postgresql://user:password@localhost:5432/harborpoint.')
  }

  if (!env.AUTH_TOKEN_SECRET || PLACEHOLDER.test(env.AUTH_TOKEN_SECRET) || env.AUTH_TOKEN_SECRET.length < 32) {
    throw new Error('AUTH_TOKEN_SECRET is required: a random string of at least 32 characters used to sign session tokens.')
  }

  if (env.SEED_DEMO_DATA && isProduction) {
    throw new Error('SEED_DEMO_DATA=true creates fictional demo accounts and cannot be used with NODE_ENV=production.')
  }

  const encryptionKey = parseEncryptionKey(env.FIELD_ENCRYPTION_KEY)
  if (env.FIELD_ENCRYPTION_KEY && !PLACEHOLDER.test(env.FIELD_ENCRYPTION_KEY) && !encryptionKey) {
    throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes, encoded as base64 or as 64 hex characters.')
  }
  // Real data needs a real key; only demo and test databases may use the development key.
  if (!encryptionKey && !(isTest || env.SEED_DEMO_DATA)) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is required (32 random bytes, base64). Bank details and claimant contact data are encrypted with it. ' +
        'Only demo (SEED_DEMO_DATA=true) and test databases may run without it.',
    )
  }

  if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY && PLACEHOLDER.test(env.ANTHROPIC_API_KEY)) {
    throw new Error('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY still holds a placeholder value. Set a real key or use AI_PROVIDER=none.')
  }

  return {
    ...env,
    isProduction,
    isTest,
    demoData: env.SEED_DEMO_DATA,
    fieldEncryptionKey: encryptionKey || DEV_ENCRYPTION_KEY,
    clientOrigins: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    serverRoot,
  }
}
