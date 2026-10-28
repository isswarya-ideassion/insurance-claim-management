import { z } from 'zod'
import { INTEGRATION_SOURCES, PRECEDENCE_RULES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

const sources = [...INTEGRATION_SOURCES, 'HUB']

export const runsQuery = paginationSchema.extend({
  source: z.enum(INTEGRATION_SOURCES).optional(),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']).optional(),
})

export const recordRunSchema = z.object({
  sourceSystem: z.enum(INTEGRATION_SOURCES),
  startedAt: z.coerce.date().optional(),
  finishedAt: z.coerce.date().optional().nullable(),
  recordsIn: z.coerce.number().int().nonnegative().default(0),
  recordsFailed: z.coerce.number().int().nonnegative().default(0),
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL']),
  checkpoint: z.string().trim().max(200).optional().nullable(),
  error: z.string().trim().max(2000).optional().nullable(),
})

export const xrefQuery = paginationSchema.extend({
  claimId: z.string().uuid().optional(),
  status: z.enum(['LINKED', 'PENDING_REVIEW', 'REJECTED']).optional(),
})

export const xrefSchema = z.object({
  claimId: z.string().uuid(),
  sourceSystem: z.enum(INTEGRATION_SOURCES),
  externalClaimId: z.string().trim().min(1).max(100),
})

export const precedenceSchema = z.object({
  fieldGroup: z.string().trim().min(2).max(60),
  sourceSystem: z.enum(sources),
  rank: z.coerce.number().int().min(1).max(10),
  rule: z.enum(PRECEDENCE_RULES),
})
