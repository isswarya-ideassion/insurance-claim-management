import { z } from 'zod'
import { POLICY_RENEWAL_STATUSES, POLICY_STATUSES, POLICY_TYPES, SEGMENTS } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const listPoliciesQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(POLICY_STATUSES).optional(),
  type: z.enum(POLICY_TYPES).optional(),
  segment: z.enum(SEGMENTS).optional(),
})

export const policyIdParams = z.object({ id: z.string().uuid() })

export const eligibilitySchema = z.object({
  policyNumber: z.string().trim().min(3).max(40),
  lossDate: z.coerce.date().optional(),
  claimType: z.enum(POLICY_TYPES).optional(),
  lossType: z.string().max(60).optional(),
  estimatedLoss: z.coerce.number().nonnegative().optional(),
})

export const renewalRequestSchema = z.object({
  termMonths: z.coerce.number().int().refine((n) => [6, 12, 24].includes(n), 'Choose a 6, 12 or 24 month term').default(12),
  notes: z.string().trim().max(500).optional().nullable(),
})

export const renewalIdParams = z.object({ id: z.string().uuid() })

export const listRenewalsQuery = paginationSchema.extend({
  status: z.enum(POLICY_RENEWAL_STATUSES).optional(),
})

export const renewalDecisionSchema = z
  .object({
    decision: z.enum(['COMPLETED', 'DECLINED']),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => v.decision !== 'DECLINED' || (v.reason && v.reason.length >= 5), { message: 'Give the customer a reason (at least 5 characters)', path: ['reason'] })
