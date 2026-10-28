import { z } from 'zod'

export const claimFormSchema = z.object({
  policyNumber: z.string().min(1, 'Select the policy this claim is for'),
  insuredName: z.string().trim().min(2, 'Enter the insured name'),
  incidentAt: z
    .string()
    .min(1, 'Enter the incident date and time')
    .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Enter a valid date and time')
    .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, 'The incident cannot be in the future'),
  incidentLocation: z.string().trim().min(3, 'Enter where the incident happened'),
  incidentCategory: z.string().min(1, 'Select an incident category'),
  incidentDescription: z.string().trim().min(20, 'Describe what happened in at least 20 characters').max(5000),
  estimatedLoss: z.coerce.number({ invalid_type_error: 'Enter an amount' }).positive('Enter an amount greater than zero').max(1e11),
  affectedAsset: z.string().trim().min(2, 'Describe the affected property or asset'),
  contactName: z.string().trim().min(2, 'Enter a contact name'),
  contactPhone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  contactEmail: z.string().trim().email('Enter a valid email address'),
  declarationAccepted: z.boolean().refine((v) => v === true, 'You must accept the declaration to submit'),
})

export const STEP_FIELDS = {
  1: ['policyNumber', 'insuredName'],
  2: ['incidentAt', 'incidentLocation', 'incidentCategory', 'incidentDescription'],
  3: ['estimatedLoss', 'affectedAsset'],
  4: [],
  5: ['contactName', 'contactPhone', 'contactEmail'],
  6: ['declarationAccepted'],
}

const SERVER_FIELD_TO_FORM = {
  policy_id: 'policyNumber',
  insured_name: 'insuredName',
  incident_at: 'incidentAt',
  incident_location: 'incidentLocation',
  incident_category: 'incidentCategory',
  incident_description: 'incidentDescription',
  estimated_loss: 'estimatedLoss',
  affected_asset: 'affectedAsset',
  contact_name: 'contactName',
  contact_phone: 'contactPhone',
  contact_email: 'contactEmail',
  declaration_accepted: 'declarationAccepted',
}

export function serverFieldToForm(field) {
  return SERVER_FIELD_TO_FORM[field] || field
}

export function stepForField(field) {
  return Number(Object.entries(STEP_FIELDS).find(([, fields]) => fields.includes(field))?.[0] || 1)
}

/** Converts form values to the API draft payload (empty values become null). */
export function toDraftPayload(values, step) {
  const text = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim())
  return {
    policyNumber: text(values.policyNumber),
    insuredName: text(values.insuredName),
    incidentAt: values.incidentAt ? new Date(values.incidentAt).toISOString() : null,
    incidentLocation: text(values.incidentLocation),
    incidentCategory: text(values.incidentCategory),
    incidentDescription: text(values.incidentDescription),
    estimatedLoss: values.estimatedLoss === '' || values.estimatedLoss == null ? null : Number(values.estimatedLoss),
    affectedAsset: text(values.affectedAsset),
    contactName: text(values.contactName),
    contactPhone: text(values.contactPhone),
    contactEmail: text(values.contactEmail),
    declarationAccepted: Boolean(values.declarationAccepted),
    draftStep: step,
  }
}
