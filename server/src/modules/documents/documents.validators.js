import { z } from 'zod'
import { DOCUMENT_CATEGORIES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const idParams = z.object({ id: z.string().uuid() })

export const uploadFieldsSchema = z.object({
  category: z.enum(DOCUMENT_CATEGORIES, { message: 'Select a valid document category' }),
  informationRequestId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  replacesDocumentId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
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
  category: z.enum(DOCUMENT_CATEGORIES).optional(),
})

export const downloadQuery = z.object({
  disposition: z.enum(['inline', 'attachment']).default('attachment'),
})

export const informationRequestSchema = z
  .object({
    requestType: z.enum(['DOCUMENT', 'INFORMATION']),
    documentCategory: z.enum(DOCUMENT_CATEGORIES).optional().nullable(),
    message: z.string().trim().min(5).max(2000),
    dueAt: z.coerce.date().optional().nullable(),
  })
  .refine((v) => v.requestType !== 'DOCUMENT' || v.documentCategory, {
    message: 'Document requests need a document category',
    path: ['documentCategory'],
  })

export const respondSchema = z.object({ responseText: z.string().trim().min(2).max(5000) })

export const listRequestsQuery = paginationSchema.extend({
  status: z.enum(['OPEN', 'RESPONDED', 'CLOSED', 'CANCELLED']).optional(),
})
