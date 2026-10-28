import { z } from 'zod'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const decisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED', 'RETURNED']),
    comments: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => v.decision === 'APPROVED' || (v.comments && v.comments.length >= 5), {
    message: 'Comments of at least 5 characters are required when rejecting or returning',
    path: ['comments'],
  })

export const queueQuery = paginationSchema
