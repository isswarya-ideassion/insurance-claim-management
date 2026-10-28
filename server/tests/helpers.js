import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { createApp } from '../src/app.js'
import { DEMO_DOMAIN } from '../src/seed/demoData.js'
import { buildSamplePdf } from '../src/seed/samplePdf.js'

export const PASSWORD = 'Test-Password-123'

/** Boots the API in mock mode with a fresh in-memory database seeded with demo data. */
export async function createTestContext() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'harborpoint-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_MODE: 'mock',
    MOCK_DB_PERSISTENCE: 'memory',
    MOCK_DATA_DIR: dataDir,
    MOCK_AUTH_SECRET: 'test-only-secret-value-0123456789',
    MOCK_DEMO_PASSWORD: PASSWORD,
    EMAIL_ADAPTER: 'console',
    OVERDUE_SWEEP_MINUTES: '0',
  })
  const deps = await createDependencies(config)
  const sentEmails = []
  const originalSend = deps.email.send
  deps.email.send = async (message) => {
    sentEmails.push(message)
    return originalSend(message)
  }
  const app = createApp(deps)
  const tokens = {}

  async function login(who) {
    if (tokens[who]) return tokens[who]
    const email = who.includes('@') ? who : `${who}@${DEMO_DOMAIN}`
    const res = await request(app).post('/api/v1/auth/mock/login').send({ email, password: PASSWORD })
    if (res.status !== 200) throw new Error(`login failed for ${who}: ${res.status} ${JSON.stringify(res.body)}`)
    tokens[who] = res.body.data.accessToken
    return tokens[who]
  }

  // supertest requests are thenables, so they are wrapped in an object until fully built.
  function as(who) {
    const build = async (method, url) => {
      const token = await login(who)
      return { req: request(app)[method](`/api/v1${url}`).set('authorization', `Bearer ${token}`) }
    }
    return {
      get: async (url) => (await build('get', url)).req,
      post: async (url, body = {}, headers = {}) => (await build('post', url)).req.set(headers).send(body),
      patch: async (url, body = {}) => (await build('patch', url)).req.send(body),
      delete: async (url) => (await build('delete', url)).req,
      upload: async (url, { buffer, filename, fields = {} }) => {
        const { req } = await build('post', url)
        for (const [k, v] of Object.entries(fields)) req.field(k, v)
        return req.attach('file', buffer, filename)
      },
    }
  }

  async function claimByNumber(number) {
    return deps.db.findOne('claims', { claim_number: number })
  }

  async function userId(who) {
    const profile = await deps.db.findOne('profiles', { email: `${who}@${DEMO_DOMAIN}` })
    return profile.id
  }

  return { app, deps, db: deps.db, login, as, claimByNumber, userId, sentEmails, close: () => deps.db.close() }
}

export const samplePdf = (label = 'test') => buildSamplePdf(['Test document', label])

export function uniqueKey() {
  return randomUUID()
}

/** Builds a complete draft body for the given policy. */
export function completeDraft(policyNumber, overrides = {}) {
  return {
    policyNumber,
    incidentAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    incidentLocation: '1 Test Street, Testville',
    incidentCategory: 'COLLISION',
    incidentDescription: 'Rear-ended at a traffic light by another vehicle; bumper damaged.',
    estimatedLoss: 2500,
    affectedAsset: 'Test vehicle',
    contactName: 'Alice Thornton',
    contactPhone: '+1 555 0101',
    contactEmail: 'alice@example.test',
    declarationAccepted: true,
    ...overrides,
  }
}
