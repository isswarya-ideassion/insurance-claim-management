import { z } from 'zod'
import { INVESTIGATION_CHECKLIST, EVALUATION_DECISIONS } from '../../../../shared/constants.js'

export const idParams = z.object({ id: z.string().uuid() })

const checklistKeys = INVESTIGATION_CHECKLIST.map((i) => i.key)

export const evaluationFieldsSchema = z
  .object({
    checklist: z
      .record(z.string(), z.boolean())
      .refine((c) => Object.keys(c).every((k) => checklistKeys.includes(k)), 'Unknown checklist item')
      .optional(),
    findings: z.string().trim().max(10000).optional().nullable(),
    evidence: z
      .array(
        z.object({
          description: z.string().trim().min(2).max(500),
          documentId: z.string().uuid().optional().nullable(),
        }),
      )
      .max(50)
      .optional(),
    lossValue: z.coerce.number().nonnegative().max(1e11).optional().nullable(),
    liabilityPct: z.coerce.number().min(0).max(100).optional().nullable(),
    recommendedSettlement: z.coerce.number().nonnegative().max(1e11).optional().nullable(),
    decision: z.enum(EVALUATION_DECISIONS).optional().nullable(),
    internalNotes: z.string().trim().max(10000).optional().nullable(),
  })
  .strict()

export const submitEvaluationSchema = z.object({
  reserveAmount: z.coerce.number().positive().max(1e11).optional(),
  reserveReason: z.string().trim().max(2000).optional().nullable(),
  coverageLine: z.string().trim().max(60).optional(),
})

export const returnEvaluationSchema = z.object({
  comment: z.string().trim().min(5, 'Explain what needs correcting').max(2000),
})
