import { z } from 'zod'
import { INDIAN_MOBILE_MESSAGE, indianMobileDigits, normalizeIndianMobile } from '@shared/constants.js'

export const claimFormSchema = z.object({
  policyNumber: z.string().min(1, 'Select the policy this claim is for'),
  insuredName: z.string().trim().min(2, 'Enter the insured name'),
  lossDate: z
    .string()
    .min(1, 'Enter the loss date and time')
    .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Enter a valid date and time')
    .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, 'The loss date and time cannot be in the future'),
  lossLocation: z.string().trim().min(3, 'Enter the address or place where the loss happened').max(500),
  lossCity: z.string().trim().min(2, 'Enter the city'),
  lossCountry: z.string().trim().min(2, 'Enter the country'),
  lossType: z.string().min(1, 'Select a loss type'),
  lossDescription: z.string().trim().min(20, 'Describe what happened in at least 20 characters').max(5000),
  estimatedLoss: z.coerce.number({ invalid_type_error: 'Enter an amount' }).positive('Enter an amount greater than zero').max(1e11),
  affectedAsset: z.string().trim().min(2, 'Describe the affected property or asset'),
  contactName: z.string().trim().min(2, 'Enter a contact name'),
  contactPhone: z.string().trim().refine((v) => indianMobileDigits(v) !== null, INDIAN_MOBILE_MESSAGE),
  contactEmail: z.string().trim().email('Enter a valid email address'),
  declarationAccepted: z.boolean().refine((v) => v === true, 'You must accept the declaration to submit'),
})

export const STEP_FIELDS = {
  1: ['policyNumber', 'insuredName'],
  2: ['lossDate', 'lossLocation', 'lossCity', 'lossCountry', 'lossType', 'lossDescription'],
  3: ['estimatedLoss', 'affectedAsset'],
  4: [],
  5: ['contactName', 'contactPhone', 'contactEmail'],
  6: ['declarationAccepted'],
}

const SERVER_FIELD_TO_FORM = {
  policy_id: 'policyNumber',
  insured_name: 'insuredName',
  loss_date: 'lossDate',
  loss_location: 'lossLocation',
  loss_city: 'lossCity',
  loss_country: 'lossCountry',
  loss_type: 'lossType',
  loss_description: 'lossDescription',
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
    lossDate: values.lossDate ? new Date(values.lossDate).toISOString() : null,
    lossLocation: text(values.lossLocation),
    lossCity: text(values.lossCity),
    lossCountry: text(values.lossCountry),
    lossType: text(values.lossType),
    lossDescription: text(values.lossDescription),
    estimatedLoss: values.estimatedLoss === '' || values.estimatedLoss == null ? null : Number(values.estimatedLoss),
    affectedAsset: text(values.affectedAsset),
    contactName: text(values.contactName),
    // An incomplete number is not sent, so saving a draft never fails on it.
    contactPhone: normalizeIndianMobile(values.contactPhone),
    contactEmail: text(values.contactEmail),
    declarationAccepted: Boolean(values.declarationAccepted),
    draftStep: step,
  }
}
