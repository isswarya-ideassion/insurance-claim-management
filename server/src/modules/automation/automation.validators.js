import { z } from 'zod'
import { DOCUMENT_CATEGORIES, EXTRACTABLE_CLAIM_FIELDS } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const reminderDraftSchema = z.object({
  categories: z.array(z.enum(DOCUMENT_CATEGORIES)).max(20).optional(),
})

export const approveReminderSchema = z.object({
  message: z.string().trim().min(20, 'The message must be at least 20 characters').max(4000).optional(),
})

export const applyExtractionSchema = z.object({
  fields: z
    .array(z.enum(EXTRACTABLE_CLAIM_FIELDS.filter((f) => f.claimField).map((f) => f.key)))
    .min(1, 'Select at least one field to apply')
    .refine((v) => new Set(v).size === v.length, 'Fields must be unique'),
})

export const listRemindersQuery = paginationSchema.extend({
  status: z.enum(['SENT', 'DRAFT', 'APPROVED', 'DISCARDED']).optional(),
  audience: z.enum(['INTERNAL', 'CUSTOMER']).optional(),
  type: z.enum(['DEADLINE_APPROACHING', 'DEADLINE_OVERDUE', 'MISSING_DOCUMENTS']).optional(),
})
