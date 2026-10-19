import { z } from 'zod'
import { ALL_STATUSES, POLICY_TYPES, PRIORITIES, INTAKE_CHECKLIST } from '../../../../shared/constants.js'
import { paginationSchema } from '../../utils/http.js'

const optionalText = (max) => z.string().trim().max(max).optional().nullable()

export const claimIdParams = z.object({ id: z.string().uuid('Invalid claim id') })

export const draftSchema = z
  .object({
    policyNumber: z.string().trim().max(40).optional().nullable(),
    claimType: z.enum(POLICY_TYPES).optional().nullable(),
    insuredName: optionalText(120),
    incidentAt: z.coerce.date().optional().nullable(),
    incidentLocation: optionalText(250),
    incidentCategory: optionalText(60),
    incidentDescription: optionalText(5000),
    estimatedLoss: z.coerce.number().nonnegative().max(1e11).optional().nullable(),
    affectedAsset: optionalText(250),
    contactName: optionalText(120),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
      .optional()
      .nullable()
      .or(z.literal('').transform(() => null)),
    contactEmail: z.string().trim().email('Enter a valid email').optional().nullable().or(z.literal('').transform(() => null)),
    declarationAccepted: z.boolean().optional(),
    draftStep: z.coerce.number().int().min(1).max(6).optional(),
  })
  .strict()

export const staffClaimUpdateSchema = z
  .object({
    priority: z.enum(PRIORITIES).optional(),
    dueDate: z.coerce.date().nullable().optional(),
  })
  .strict()

/** Completeness rules applied at submission time. */
export const submissionReadySchema = z.object({
  policy_id: z.string().uuid({ message: 'Select a policy' }),
  claim_type: z.enum(POLICY_TYPES, { message: 'Claim type is required' }),
  insured_name: z.string({ message: 'Insured name is required' }).min(2, 'Insured name is required'),
  incident_at: z.coerce.date({ message: 'Incident date and time are required' }),
  incident_location: z.string({ message: 'Incident location is required' }).min(3, 'Incident location is required'),
  incident_category: z.string({ message: 'Incident category is required' }).min(2),
  incident_description: z
    .string({ message: 'Incident description is required' })
    .min(20, 'Describe the incident in at least 20 characters'),
  estimated_loss: z.coerce.number({ message: 'Estimated loss is required' }).positive('Estimated loss must be greater than zero'),
  affected_asset: z.string({ message: 'Affected property or asset is required' }).min(2),
  contact_name: z.string({ message: 'Contact name is required' }).min(2),
  contact_phone: z.string({ message: 'Phone number is required' }).min(7),
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
  claimType: csv(POLICY_TYPES),
  priority: csv(PRIORITIES),
  assigneeId: z.union([z.string().uuid(), z.literal('unassigned'), z.literal('me')]).optional(),
  needsAdjuster: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  escalated: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z
    .enum(['submitted_at', 'created_at', 'updated_at', 'estimated_loss', 'due_date', 'claim_number', 'status', 'priority'])
    .default('submitted_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const transitionSchema = z.object({
  toStatus: z.enum(ALL_STATUSES),
  reason: z.string().trim().max(2000).optional().nullable(),
  customerMessage: z.string().trim().max(1000).optional().nullable(),
})

export const verifyPolicySchema = z.object({
  verified: z.boolean(),
  notes: z.string().trim().max(2000).optional().nullable(),
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
