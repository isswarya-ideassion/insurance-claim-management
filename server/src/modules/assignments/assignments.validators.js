import { z } from 'zod'
import { ASSIGNMENT_ROLES, STAFF_ROLES } from '../../../../shared/constants.js'

export const claimParams = z.object({ id: z.string().uuid() })

export const assignSchema = z.object({
  assigneeId: z.string().uuid(),
  assignmentRole: z.enum(ASSIGNMENT_ROLES),
  reason: z.string().trim().max(1000).optional().nullable(),
})

export const assigneesQuery = z.object({
  role: z.enum(STAFF_ROLES),
})
