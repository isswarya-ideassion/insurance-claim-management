import { z } from 'zod'
import { RESERVE_REASON_CODES, RESERVE_REVIEW_DECISIONS } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const reviewSchema = z
  .object({
    decision: z.enum(RESERVE_REVIEW_DECISIONS),
    comments: z.string().trim().max(2000).optional().nullable(),
    modifiedAmount: z.coerce.number().positive().max(1e11).optional(),
  })
  .refine((v) => v.decision === 'APPROVED' || (v.comments && v.comments.length >= 5), {
    message: 'Comments of at least 5 characters are required unless the reserve is approved as is',
    path: ['comments'],
  })
  .refine((v) => v.decision !== 'MODIFIED' || v.modifiedAmount, {
    message: 'Enter the modified reserve amount',
    path: ['modifiedAmount'],
  })

export const reviseSchema = z.object({
  amount: z.coerce.number().nonnegative().max(1e11),
  coverageLine: z.string().trim().max(60).optional(),
  // Manager modifications, payment and closure entries are recorded by the system, not entered here.
  reasonCode: z.enum(RESERVE_REASON_CODES.filter((c) => !['MANAGER_MODIFIED', 'PAYMENT_ISSUED', 'CLOSURE_RELEASE'].includes(c))),
  notes: z.string().trim().max(2000).optional().nullable(),
})

export const queueQuery = paginationSchema
