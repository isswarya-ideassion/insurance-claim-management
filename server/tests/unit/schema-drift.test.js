import { describe, expect, it } from 'vitest'
import { getAutopilotState, getAutopilotSummary } from '../../src/modules/automation/autopilot.service.js'
import { reviewQueue } from '../../src/modules/documents/documents.service.js'
import { fromDatabaseError, isMissingSchemaError } from '../../src/utils/errors.js'
import { ROLES } from '../../../shared/constants.js'

// A database where the Auto-Pilot migration (20261120000019) has not been applied yet.
const pgError = (code, message) => Object.assign(new Error(message), { code })
const missingTable = () => pgError('42P01', 'relation "public.autopilot_actions" does not exist')
const missingColumn = () => pgError('42703', 'column "ai_escalated_at" does not exist')

describe('schema drift: Auto-Pilot migration not applied', () => {
  it('recognises missing tables and columns only', () => {
    expect(isMissingSchemaError(missingTable())).toBe(true)
    expect(isMissingSchemaError(missingColumn())).toBe(true)
    expect(isMissingSchemaError(pgError('23505', 'duplicate'))).toBe(false)
    expect(fromDatabaseError(missingTable())).toMatchObject({ status: 503, code: 'SCHEMA_OUT_OF_DATE' })
  })

  it('summary returns empty metrics instead of failing', async () => {
    const db = {
      query: async () => {
        throw missingTable()
      },
      findOne: async () => {
        throw missingTable()
      },
    }
    const ctx = { db, actor: { id: 'u1', roles: [ROLES.CLAIMS_OPS_MANAGER] }, config: {}, ai: null }
    const summary = await getAutopilotSummary(ctx, { days: 30 })
    expect(summary.totals).toMatchObject({ routineTasksAutomated: 0, escalated: 0, humanExceptionsRemaining: 0, stpRate: null })
    expect(summary.recent).toEqual([])
    expect(summary.enabled).toBe(false)
    expect((await getAutopilotState(ctx)).enabled).toBe(false)
  })

  it('summary still surfaces unrelated database errors', async () => {
    const db = {
      query: async () => {
        throw pgError('08006', 'connection failure')
      },
      findOne: async () => null,
    }
    const ctx = { db, actor: { id: 'u1', roles: [ROLES.CLAIMS_OPS_MANAGER] }, config: {} }
    await expect(getAutopilotSummary(ctx)).rejects.toThrow('connection failure')
  })

  it('review queue falls back to oldest-first when documents.ai_escalated_at is missing', async () => {
    const orders = []
    const doc = { id: 'd1', claim_id: 'c1', status: 'PENDING_REVIEW', doc_type: 'OTHER', storage_key: 'k' }
    const db = {
      findMany: async (table, opts) => {
        if (table === 'claims') return opts.columns?.length === 1 ? [{ id: 'c1' }] : [{ id: 'c1', claim_number: 'HPC-1', customer_id: null }]
        if (table === 'documents') {
          orders.push(opts.orderBy.map(([col]) => col))
          if (opts.orderBy.some(([col]) => col === 'ai_escalated_at')) throw missingColumn()
          return [doc]
        }
        return []
      },
      count: async () => 1,
      query: async () => [],
    }
    const ctx = { db, actor: { id: 'u1', roles: [ROLES.CLAIMS_OPS_MANAGER, ROLES.DOCUMENT_REVIEWER] } }
    const { items, meta } = await reviewQueue(ctx, { status: 'PENDING_REVIEW', page: 1, pageSize: 20 })
    expect(orders).toEqual([['ai_escalated_at', 'received_at'], ['received_at']])
    expect(items).toHaveLength(1)
    expect(items[0].claim_number).toBe('HPC-1')
    expect(meta.total).toBe(1)
  })
})
