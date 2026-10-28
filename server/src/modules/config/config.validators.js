import { z } from 'zod'
import { SEGMENTS } from '../../../../shared/constants.js'

export const idParams = z.object({ id: z.string().uuid() })

export const proposalSchema = z.object({
  segment: z.enum(SEGMENTS),
  configKey: z.string().trim().min(3).max(60),
  configValue: z.unknown(),
  notes: z.string().trim().max(1000).optional().nullable(),
})

export const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().trim().max(1000).optional().nullable(),
})
