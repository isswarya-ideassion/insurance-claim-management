import { z } from 'zod'
import {
  ALL_STATUSES,
  COVERAGE_RESULTS,
  INDIAN_MOBILE_MESSAGE,
  INTAKE_CHECKLIST,
  LIFECYCLE_STAGES,
  POLICY_TYPES,
  PRIORITIES,
  SEGMENTS,
  indianMobileDigits,
} from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'
import { indianMobile } from '../../utils/phone.js'

const optionalText = (max) => z.string().trim().max(max).optional().nullable()

// A few minutes of tolerance for clock differences between the browser and the server.
const FUTURE_TOLERANCE_MS = 5 * 60_000
const notFuture = (d) => d == null || d.getTime() <= Date.now() + FUTURE_TOLERANCE_MS

export const claimIdParams = z.object({ id: z.string().uuid('Invalid claim id') })

// Optimistic locking: send the version you loaded; a stale version returns 409 VERSION_CONFLICT.
const version = z.coerce.number().int().min(1).optional()

export const draftSchema = z
  .object({
    policyNumber: z.string().trim().max(40).optional().nullable(),
    claimType: z.enum(POLICY_TYPES).optional().nullable(),
    insuredName: optionalText(120),
    lossDate: z.coerce.date().optional().nullable().refine(notFuture, 'The loss date and time cannot be in the future'),
    lossLocation: optionalText(500),
    lossCity: optionalText(100),
    lossCountry: optionalText(100),
    lossType: optionalText(60),
    lossDescription: optionalText(5000),
    estimatedLoss: z.coerce.number().nonnegative().max(1e11).optional().nullable(),
    affectedAsset: optionalText(250),
    contactName: optionalText(120),
    contactPhone: z.literal('').transform(() => null).or(indianMobile).optional().nullable(),
    contactEmail: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('').transform(() => null)),
    declarationAccepted: z.boolean().optional(),
    draftStep: z.coerce.number().int().min(1).max(6).optional(),
    version,
  })
  .strict()

export const staffClaimUpdateSchema = z
  .object({
    priority: z.enum(PRIORITIES).optional(),
    dueDate: z.coerce.date().nullable().optional(),
    complexity: z.coerce.number().int().min(1).max(4).nullable().optional(),
    version,
  })
  .strict()

/** Completeness rules applied at submission time (claim columns plus the claimant's contact details). */
export const submissionReadySchema = z.object({
  policy_id: z.string().uuid({ message: 'Select a policy' }),
  claim_type: z.enum(POLICY_TYPES, { message: 'Claim type is required' }),
  insured_name: z.string({ message: 'Insured name is required' }).min(2, 'Insured name is required'),
  loss_date: z.coerce.date({ message: 'Loss date and time are required' }),
  loss_location: z.string({ message: 'Loss location is required' }).min(3, 'Loss location is required'),
  loss_city: z.string({ message: 'City is required' }).trim().min(2, 'City is required'),
  loss_country: z.string({ message: 'Country is required' }).trim().min(2, 'Country is required'),
  loss_type: z.string({ message: 'Loss type is required' }).min(2),
  loss_description: z
    .string({ message: 'Loss description is required' })
    .min(20, 'Describe the loss in at least 20 characters'),
  estimated_loss: z.coerce.number({ message: 'Estimated loss is required' }).positive('Estimated loss must be greater than zero'),
  affected_asset: z.string({ message: 'Affected property or asset is required' }).min(2),
  contact_name: z.string({ message: 'Contact name is required' }).min(2),
  contact_phone: z.string({ message: 'Phone number is required' }).refine((v) => indianMobileDigits(v) !== null, INDIAN_MOBILE_MESSAGE),
  contact_email: z.string({ message: 'Email is required' }).email(),
  declaration_accepted: z.literal(true, { message: 'You must accept the declaration and consent' }),
})

export const submitSchema = z.object({
  submissionKey: z.string().uuid().optional(),
  confirmSeparateClaim: z.boolean().optional().default(false),
})

const csv = (values) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .refine((list) => !list || list.every((s) => values.includes(s)), 'Invalid value')

export const listClaimsQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: csv(ALL_STATUSES),
  stage: csv(LIFECYCLE_STAGES),
  segment: z.enum(SEGMENTS).optional(),
  claimType: csv(POLICY_TYPES),
  priority: csv(PRIORITIES),
  assigneeId: z.union([z.string().uuid(), z.literal('unassigned'), z.literal('me')]).optional(),
  needsAdjuster: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  escalated: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z
    .enum(['opened_at', 'created_at', 'updated_at', 'estimated_loss', 'due_date', 'claim_number', 'status', 'priority', 'severity'])
    .default('opened_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const transitionSchema = z.object({
  toStatus: z.enum(ALL_STATUSES),
  reason: z.string().trim().max(2000).optional().nullable(),
  customerMessage: z.string().trim().max(1000).optional().nullable(),
})

export const coverageSchema = z.object({
  result: z.enum(COVERAGE_RESULTS),
  notes: z.string().trim().max(2000).optional().nullable(),
  clauseRefs: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})

const checklistKeys = INTAKE_CHECKLIST.map((i) => i.key)
export const intakeChecklistSchema = z.object({
  items: z.record(z.string(), z.boolean()).refine(
    (items) => Object.keys(items).every((k) => checklistKeys.includes(k)),
    'Unknown checklist item',
  ),
})

export const escalateSchema = z.object({
  reason: z.string().trim().min(5, 'Provide an escalation reason').max(2000),
})

export const documentExceptionSchema = z.object({
  reason: z.string().trim().min(10, 'Explain why the document requirement is waived').max(2000),
})

export const noteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(['INTERNAL', 'CUSTOMER']).default('INTERNAL'),
})
