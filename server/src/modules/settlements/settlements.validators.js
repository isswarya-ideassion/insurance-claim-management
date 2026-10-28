import { z } from 'zod'
import { SETTLEMENT_DECISIONS, RESERVE_REVIEW_DECISIONS } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const decisionSchema = z
  .object({
    decision: z.enum(SETTLEMENT_DECISIONS),
    comments: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => v.decision === 'APPROVED' || (v.comments && v.comments.length >= 5), {
    message: 'Comments of at least 5 characters are required when rejecting or returning',
    path: ['comments'],
  })

export const queueQuery = paginationSchema.extend({
  // Only settlements whose pending step needs one of the caller's roles.
  awaitingMe: z.enum(['true', 'false']).optional(),
})

export const historyQuery = paginationSchema.extend({
  type: z.enum(['RESERVE', 'EVALUATION', 'CLOSURE', 'SETTLEMENT']).optional(),
  decision: z.enum([...new Set([...RESERVE_REVIEW_DECISIONS, ...SETTLEMENT_DECISIONS])]).optional(),
  mine: z.enum(['true', 'false']).optional(),
})
