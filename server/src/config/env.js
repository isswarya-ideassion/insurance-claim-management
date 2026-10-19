import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  DATA_MODE: z.enum(['supabase', 'mock']).default('mock'),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_DB_URL: z.string().optional(),
  SUPABASE_DB_SSL: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  SUPABASE_STORAGE_BUCKET: z.string().default('claim-documents'),

  MOCK_DATA_DIR: z.string().default('./.data'),
  MOCK_DB_PERSISTENCE: z.enum(['file', 'memory']).default('file'),
  MOCK_AUTH_SECRET: z.string().optional(),
  MOCK_DEMO_PASSWORD: z.string().default('HarborDemo!2026'),

  EMAIL_ADAPTER: z.enum(['console', 'disabled']).default('console'),
  EMAIL_FROM: z.string().default('claims@harborpoint.example'),
  PAYMENT_ADAPTER: z.enum(['simulated']).default('simulated'),
  OVERDUE_SWEEP_MINUTES: z.coerce.number().min(0).default(15),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().optional(),
})

const PLACEHOLDER = /your-|change-me|placeholder/i

export function loadConfig(overrides = {}) {
  const parsed = schema.safeParse({ ...process.env, ...overrides })
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid server configuration: ${issues}`)
  }
  const env = parsed.data

  if (env.DATA_MODE === 'mock' && env.NODE_ENV === 'production') {
    throw new Error('DATA_MODE=mock is a local demo mode and cannot run with NODE_ENV=production.')
  }

  if (env.DATA_MODE === 'supabase') {
    const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL'].filter(
      (k) => !env[k] || PLACEHOLDER.test(env[k]),
    )
    if (missing.length) {
      throw new Error(
        `DATA_MODE=supabase requires real values for: ${missing.join(', ')}. ` +
          'Set them in server/.env or use DATA_MODE=mock for the local demo. ' +
          'The server never falls back to mock mode automatically.',
      )
    }
  }

  const dataDir = path.resolve(serverRoot, env.MOCK_DATA_DIR)
  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isMock: env.DATA_MODE === 'mock',
    clientOrigins: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    mock: {
      dataDir,
      dbDir: env.MOCK_DB_PERSISTENCE === 'memory' ? null : path.join(dataDir, 'pgdata'),
      uploadsDir: path.join(dataDir, 'uploads'),
    },
    serverRoot,
  }
}
