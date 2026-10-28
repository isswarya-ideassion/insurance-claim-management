import { z } from 'zod'
import { RECOVERY_STATUSES, RECOVERY_TYPES } from '../../../../shared/constants.js'

export const idParams = z.object({ id: z.string().uuid() })

export const closureRequestSchema = z.object({
  reason: z.string().trim().min(10, 'Explain why the claim can be closed').max(2000),
})

export const closureDecisionSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => v.decision === 'APPROVED' || (v.comment && v.comment.length >= 5), {
    message: 'Explain why the closure request is rejected',
    path: ['comment'],
  })

const money = z.coerce.number().nonnegative().max(1e11)

export const recoverySchema = z.object({
  type: z.enum(RECOVERY_TYPES),
  targetParty: z.string().trim().max(200).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  expectedAmount: money.optional().nullable(),
  deadline: z.string().date().optional().nullable(),
})

export const recoveryUpdateSchema = z
  .object({
    status: z.enum(RECOVERY_STATUSES).optional(),
    recoveredAmount: money.optional(),
    expectedAmount: money.optional().nullable(),
    targetParty: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
    deadline: z.string().date().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
