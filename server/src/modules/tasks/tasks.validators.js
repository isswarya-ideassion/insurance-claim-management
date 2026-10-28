import { z } from 'zod'
import { PRIORITIES, TASK_STATUSES, TASK_TYPES, STAFF_ROLES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const listTasksQuery = paginationSchema.extend({
  view: z.enum(['mine', 'team']).default('mine'),
  claimId: z.string().uuid().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .refine((l) => !l || l.every((s) => TASK_STATUSES.includes(s)), 'Invalid status'),
  overdue: z.enum(['true', 'false']).optional(),
  unclaimed: z.enum(['true', 'false']).optional(),
})

export const createTaskSchema = z.object({
  claimId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  type: z.enum(TASK_TYPES).default('GENERAL'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  blocking: z.boolean().default(false),
  ownerUserId: z.string().uuid().optional().nullable(),
  ownerRole: z.enum(STAFF_ROLES).optional().nullable(),
  dueAt: z.coerce.date().optional().nullable(),
})

export const updateTaskSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    dueAt: z.coerce.date().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
