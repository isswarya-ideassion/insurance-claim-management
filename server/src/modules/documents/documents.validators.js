import { z } from 'zod'
import { ARTIFACT_STATUSES, DOCUMENT_TYPES, REQUIREMENT_TYPES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

const optionalId = z.string().uuid().optional().or(z.literal('').transform(() => undefined))

export const uploadFieldsSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES, { message: 'Select a valid document type' }),
  artifactRequirementId: optionalId,
  replacesDocumentId: optionalId,
  changeReason: z.string().trim().max(500).optional(),
  source: z.enum(['WEB', 'PWA']).optional(),
})

export const reviewSchema = z
  .object({
    decision: z.enum(['ACCEPT', 'REJECT']),
    comment: z.string().trim().max(2000).optional().nullable(),
    rejectionReason: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => v.decision !== 'REJECT' || (v.rejectionReason && v.rejectionReason.length >= 5), {
    message: 'A rejection reason of at least 5 characters is required',
    path: ['rejectionReason'],
  })

export const assignReviewerSchema = z.object({ reviewerId: z.string().uuid() })

export const reviewQueueQuery = paginationSchema.extend({
  status: z.enum(['PENDING_REVIEW', 'ACCEPTED', 'REJECTED']).default('PENDING_REVIEW'),
  mine: z.enum(['true', 'false']).optional(),
  docType: z.enum(DOCUMENT_TYPES).optional(),
})

export const downloadQuery = z.object({
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
  version: z.coerce.number().int().min(1).optional(),
})

export const artifactRequestSchema = z
  .object({
    requirementType: z.enum(REQUIREMENT_TYPES),
    docType: z.enum(DOCUMENT_TYPES).optional().nullable(),
    message: z.string().trim().min(5).max(2000),
    dueAt: z.coerce.date().optional().nullable(),
  })
  .refine((v) => v.requirementType !== 'DOCUMENT' || v.docType, {
    message: 'Document requests need a document type',
    path: ['docType'],
  })

export const respondSchema = z.object({ responseText: z.string().trim().min(2).max(5000) })

export const listRequestsQuery = paginationSchema.extend({
  status: z.enum(ARTIFACT_STATUSES).optional(),
})
