import { z } from 'zod'
import { POLICY_TYPES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const listPoliciesQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED']).optional(),
  type: z.enum(POLICY_TYPES).optional(),
})

export const policyIdParams = z.object({ id: z.string().uuid() })

export const eligibilitySchema = z.object({
  policyNumber: z.string().trim().min(3).max(40),
  incidentAt: z.coerce.date().optional(),
  claimType: z.enum(POLICY_TYPES).optional(),
  incidentCategory: z.string().max(60).optional(),
  estimatedLoss: z.coerce.number().nonnegative().optional(),
})
