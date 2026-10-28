import { z } from 'zod'
import { COMPLIANCE_CHECKLIST, FRAUD_REASON_CODES, FRAUD_SEVERITIES, COMPLIANCE_STATUSES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

const riskFlag = z.object({
  id: z.string().uuid().optional(),
  code: z.enum(FRAUD_REASON_CODES),
  severity: z.enum(FRAUD_SEVERITIES),
  note: z.string().trim().max(1000).optional().nullable(),
  resolved: z.boolean().default(false),
})

const evidenceItem = z.object({
  description: z.string().trim().min(2).max(500),
  documentId: z.string().uuid().optional().nullable(),
})

const checklistKeys = COMPLIANCE_CHECKLIST.map((i) => i.key)

export const openReviewSchema = z.object({
  placeHold: z.boolean().default(false),
  notes: z.string().trim().min(5).max(2000),
  riskFlags: z.array(riskFlag).max(20).default([]),
})

export const updateReviewSchema = z
  .object({
    checklist: z
      .record(z.string(), z.boolean())
      .refine((c) => Object.keys(c).every((k) => checklistKeys.includes(k)), 'Unknown checklist item')
      .optional(),
    riskFlags: z.array(riskFlag).max(20).optional(),
    evidence: z.array(evidenceItem).max(50).optional(),
    decisionNotes: z.string().trim().max(5000).optional().nullable(),
    escalationNotes: z.string().trim().max(5000).optional().nullable(),
  })
  .strict()

export const decisionSchema = z
  .object({
    decision: z.enum(['CLEAR', 'HOLD', 'EXCEPTION', 'ESCALATE']),
    notes: z.string().trim().max(5000).optional().nullable(),
    exceptionReason: z.string().trim().max(5000).optional().nullable(),
  })
  .refine((v) => v.decision !== 'EXCEPTION' || (v.exceptionReason && v.exceptionReason.length >= 20), {
    message: 'An exception requires a justification of at least 20 characters',
    path: ['exceptionReason'],
  })
  .refine((v) => !['HOLD', 'ESCALATE'].includes(v.decision) || (v.notes && v.notes.length >= 5), {
    message: 'Notes are required for holds and escalations',
    path: ['notes'],
  })

export const queueQuery = paginationSchema.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .refine((l) => !l || l.every((s) => COMPLIANCE_STATUSES.includes(s)), 'Invalid status'),
})
