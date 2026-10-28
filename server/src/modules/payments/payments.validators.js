import { z } from 'zod'
import { PAYMENT_STATUSES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const listPaymentsQuery = paginationSchema.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .refine((l) => !l || l.every((s) => PAYMENT_STATUSES.includes(s)), 'Invalid status'),
  search: z.string().trim().max(100).optional(),
})

export const idempotencyKeySchema = z
  .string({ message: 'Idempotency-Key header is required' })
  .trim()
  .min(8, 'Idempotency-Key must be at least 8 characters')
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key may only contain letters, digits, - and _')

export const resolveBlockSchema = z.object({ resolution: z.string().trim().min(5, 'Describe how the block was resolved').max(1000) })

export const beneficiarySchema = z.object({
  beneficiaryName: z.string().trim().min(2).max(120),
  beneficiaryBank: z.string().trim().max(120).optional().nullable(),
  beneficiaryAccount: z.string().trim().regex(/^[0-9]{6,20}$/, 'Account number must be 6–20 digits'),
  reason: z.string().trim().min(5).max(1000),
})

export const claimPayeeSchema = z.object({
  payeeName: z.string().trim().min(2).max(120),
  bankName: z.string().trim().max(120).optional().nullable(),
  accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, 'Account number must be 6–20 digits'),
  reason: z.string().trim().min(5, 'Say where the details came from').max(1000),
})

export const verifyPayeeSchema = z.object({ notes: z.string().trim().max(1000).optional().nullable() })

export const reconcileSchema = z.object({
  reconciliationReference: z.string().trim().min(3).max(100),
  notes: z.string().trim().max(1000).optional().nullable(),
})
