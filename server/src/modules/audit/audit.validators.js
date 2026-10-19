import { z } from 'zod'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const auditQuery = paginationSchema.extend({
  claimId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  entityType: z.string().trim().max(50).optional(),
  action: z.string().trim().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
