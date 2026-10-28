import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createTestContext } from '../helpers.js'
import { TEST_SETTINGS } from '../test-db.js'

let ctx
beforeAll(async () => {
  ctx = await createTestContext()
})
afterAll(() => ctx.close())

describe('scheduled jobs endpoint (Vercel Cron)', () => {
  it('runs every job with the cron secret and refuses anyone else', async () => {
    expect((await request(ctx.app).get('/api/v1/internal/cron/jobs')).status).toBe(401)
    expect((await request(ctx.app).get('/api/v1/internal/cron/jobs').set('authorization', 'Bearer wrong-secret-value')).status).toBe(401)
    // A signed-in user's token is not the cron secret.
    const token = await ctx.login('compliance.carlos')
    expect((await request(ctx.app).get('/api/v1/internal/cron/jobs').set('authorization', `Bearer ${token}`)).status).toBe(401)

    const res = await request(ctx.app).get('/api/v1/internal/cron/jobs').set('authorization', `Bearer ${TEST_SETTINGS.CRON_SECRET}`)
    expect(res.status).toBe(200)
    expect(res.body.data.jobs).toEqual({ overdueTasks: 'ok', deadlineReminders: 'ok', slaEscalation: 'ok', partitions: 'ok' })
  })
})
