import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import request from 'supertest'
import { inject } from 'vitest'
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { createApp } from '../src/app.js'
import { DEMO_DOMAIN } from '../src/seed/demoData.js'
import { buildSamplePdf } from '../src/seed/samplePdf.js'
import { PASSWORD, TEST_SETTINGS, adminUrl, databaseUrl } from './test-db.js'

export { PASSWORD }

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: adminUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Boots the real API on a private PostgreSQL database cloned from the
 * migrated and seeded template built by tests/global-setup.js.
 */
export async function createTestContext() {
  const template = inject('templateDatabase')
  const name = `${template}_${randomBytes(4).toString('hex')}`
  await withAdmin((c) => c.query(`create database ${name} template ${template}`))
  const config = loadConfig({ ...TEST_SETTINGS, DATABASE_URL: databaseUrl(name), DB_MIGRATE_ON_START: 'false' })
  const deps = await createDependencies(config, { seed: false })
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
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })
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
      put: async (url, body = {}) => (await build('put', url)).req.send(body),
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
    const profile = await deps.db.findOne('users', { email: `${who}@${DEMO_DOMAIN}` })
    return profile.id
  }

  async function close() {
    await deps.db.close()
    await withAdmin((c) => c.query(`drop database if exists ${name} with (force)`))
  }

  return { app, deps, db: deps.db, login, as, claimByNumber, userId, sentEmails, close }
}

export const samplePdf = (label = 'test') => buildSamplePdf(['Test document', label])

export function uniqueKey() {
  return randomUUID()
}

/** Builds a complete draft body for the given policy. */
export function completeDraft(policyNumber, overrides = {}) {
  return {
    policyNumber,
    lossDate: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lossLocation: '12 MG Road, near the metro station',
    lossCity: 'Bengaluru',
    lossCountry: 'India',
    lossType: 'COLLISION',
    lossDescription: 'Rear-ended at a traffic light by another vehicle; bumper damaged.',
    estimatedLoss: 2500,
    affectedAsset: 'Test vehicle',
    contactName: 'Alice Thornton',
    contactPhone: '+91 98450 10101',
    contactEmail: 'alice@example.test',
    declarationAccepted: true,
    ...overrides,
  }
}
