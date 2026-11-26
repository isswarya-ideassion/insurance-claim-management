import { describe, expect, it } from 'vitest'
import { assertSeedTarget, buildE2eScenario, E2E_DOMAIN } from '../../src/seed/e2eDemo.js'
import { migrationFiles, pendingMigrations } from '../../src/db/migrate.js'

describe('E2E seed: target guard', () => {
  it('allows localhost without a flag', () => {
    expect(assertSeedTarget({ host: 'localhost', allowRemote: false })).toEqual({ local: true })
    expect(assertSeedTarget({ host: '127.0.0.1', allowRemote: false })).toEqual({ local: true })
  })

  it('refuses a remote host unless explicitly allowed', () => {
    expect(() => assertSeedTarget({ host: 'ep-cool-cloud-123.ap-southeast-1.aws.neon.tech', allowRemote: false })).toThrow(/Refusing to seed/)
    expect(assertSeedTarget({ host: 'ep-cool-cloud-123.neon.tech', allowRemote: true })).toEqual({ local: false })
  })
})

describe('E2E seed: scenario data', () => {
  const today = new Date('2026-11-26T00:00:00Z')
  const { FLOW1, FLOW2 } = buildE2eScenario(today)

  it('keeps the two E2E accounts, policies and the duplicate receipt name', () => {
    expect(FLOW1.user.email).toBe(`e2e.meera@${E2E_DOMAIN}`)
    expect(FLOW2.user.email).toBe(`e2e.rohan@${E2E_DOMAIN}`)
    expect(FLOW1.policy.number).toBe('HP-HLT-E2E101')
    expect(FLOW2.policy.number).toBe('HP-HLT-E2E202')
    expect(FLOW2.olderFileName).toBe('previous-claim-receipt.png')
  })

  it('dates the scenarios relative to the day they are seeded', () => {
    expect(FLOW1.claim.lossDate.toISOString().slice(0, 10)).toBe('2026-11-21')
    expect(FLOW2.claim.lossDate.toISOString().slice(0, 10)).toBe('2026-11-20')
  })
})

describe('migrations: pending check (read-only)', () => {
  const files = migrationFiles()
  const executorReturning = (rows) => ({ query: async () => ({ rows }) })

  it('reports nothing pending when every file is recorded', async () => {
    expect(await pendingMigrations(executorReturning(files.map((name) => ({ name }))))).toEqual([])
  })

  it('reports only the files that are not recorded', async () => {
    const recorded = files.filter((f) => f !== '20261120000019_beacon_autopilot.sql').map((name) => ({ name }))
    expect(await pendingMigrations(executorReturning(recorded))).toEqual(['20261120000019_beacon_autopilot.sql'])
  })

  it('treats every file as pending when the tracking table does not exist', async () => {
    const executor = {
      query: async () => {
        throw Object.assign(new Error('relation does not exist'), { code: '42P01' })
      },
    }
    expect(await pendingMigrations(executor)).toEqual(files)
  })

  it('rethrows other database errors', async () => {
    const executor = {
      query: async () => {
        throw Object.assign(new Error('connection refused'), { code: '08001' })
      },
    }
    await expect(pendingMigrations(executor)).rejects.toThrow('connection refused')
  })
})
