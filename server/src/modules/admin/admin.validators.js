import { z } from 'zod'
import { ALL_ROLES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'
import { passwordSchema } from '../auth/auth.validators.js'

export const userParams = z.object({ id: z.string().uuid() })
export const roleParams = z.object({ id: z.string().uuid(), roleCode: z.enum(ALL_ROLES) })

export const listUsersQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  role: z.enum(ALL_ROLES).optional(),
})

const roleGrant = z.object({
  roleCode: z.enum(ALL_ROLES),
  approvalLimit: z.coerce.number().nonnegative().max(1e11).optional().nullable(),
})

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional().nullable(),
  password: passwordSchema,
  roles: z.array(roleGrant).min(1, 'Grant at least one role'),
})

export const grantRoleSchema = roleGrant

export const updateUserSchema = z.object({ isActive: z.boolean() })
