import { z } from 'zod'
import { CLAIM_AGENTS, DOCUMENT_TYPES, EXTRACTABLE_CLAIM_FIELDS } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const reminderDraftSchema = z.object({
  categories: z.array(z.enum(DOCUMENT_TYPES)).max(20).optional(),
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

// Claim agents. The body of an apply request is validated by each agent.
export const agentParams = z.object({ id: z.string().uuid(), agent: z.enum(Object.keys(CLAIM_AGENTS)) })
export const applyAgentSchema = z.record(z.string(), z.unknown())
export const discardAgentSchema = z.object({ reason: z.string().trim().max(1000).optional() })
