import { z } from 'zod'
import { POLICY_TYPES } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

export const customerParams = z.object({ id: z.string().uuid() })
export const customerDocumentParams = z.object({ id: z.string().uuid(), documentId: z.string().uuid() })

const filters = {
  search: z.string().trim().max(100).optional(),
  policyType: z.enum(POLICY_TYPES).optional(),
  policyStatus: z.enum(['ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED']).optional(),
  hasOpenClaims: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  possibleDuplicate: z.enum(['true']).optional(),
  sort: z.enum(['name', 'created_at', 'last_claim_at', 'claim_count', 'last_activity_at']).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
}

export const listCustomersQuery = paginationSchema.extend(filters)
export const exportCustomersQuery = z.object(filters)
export const downloadQuery = z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') })
