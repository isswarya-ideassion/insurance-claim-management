import { z } from 'zod'
import { paginationSchema } from '../../utils/http.js'

export { decisionSchema } from '../reserves/reserves.validators.js'

export const idParams = z.object({ id: z.string().uuid() })

export const queueQuery = paginationSchema

export const historyQuery = paginationSchema.extend({
  type: z.enum(['RESERVE', 'SETTLEMENT']).optional(),
  decision: z.enum(['APPROVED', 'REJECTED', 'RETURNED']).optional(),
  mine: z.enum(['true', 'false']).optional(),
})
