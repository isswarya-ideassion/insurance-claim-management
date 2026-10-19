import { z } from 'zod'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const listNotificationsQuery = paginationSchema.extend({
  unread: z.enum(['true', 'false']).optional(),
})
