import { z } from 'zod'
import { ALL_ROLES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'
import { passwordSchema } from '../auth/auth.validators.js'
import { indianMobile } from '../../utils/phone.js'

export const userParams = z.object({ id: z.string().uuid() })
export const roleParams = z.object({ id: z.string().uuid(), roleCode: z.enum(ALL_ROLES) })

export const listUsersQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  role: z.enum(ALL_ROLES).optional(),
})

const limit = z.coerce.number().nonnegative().max(1e11).optional().nullable()
const attributes = {
  reserveLimit: limit,
  settlementLimit: limit,
  region: z.string().trim().max(60).optional().nullable(),
  teamId: z.string().trim().max(60).optional().nullable(),
}

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(120),
  phone: z.literal('').transform(() => null).or(indianMobile).optional().nullable(),
  password: passwordSchema,
  roles: z.array(z.enum(ALL_ROLES)).min(1, 'Grant at least one role'),
  ...attributes,
})

export const grantRoleSchema = z.object({ roleCode: z.enum(ALL_ROLES), ...attributes })

export const attributesSchema = z.object(attributes)

export const updateUserSchema = z.object({ isActive: z.boolean() })
