import { z } from 'zod'
import {
  INDIAN_MOBILE_MESSAGE,
  indianMobileDigits,
  normalizeIndianMobile,
} from '@shared/constants.js'

export function createClaimFormSchema({
  isHealthClaim = false,
  isTravelMedicalClaim = false,
} = {}) {
  const messages = {
    insuredName: 'Enter the insured name as shown on the policy',

    lossDate: 'Enter the date and time of the medical incident',

    futureDate: 'The medical incident date and time cannot be in the future',

    location: isHealthClaim
      ? 'Enter the hospital or clinic name and address'
      : isTravelMedicalClaim
        ? 'Enter the hospital or clinic name and address abroad'
        : 'Enter the address or place where the loss happened',

    city: isHealthClaim
      ? 'Enter the city where medical treatment was received'
      : isTravelMedicalClaim
        ? 'Enter the city where the medical emergency occurred'
        : 'Enter the city',

    country: isTravelMedicalClaim
      ? 'Enter the country where the medical emergency occurred'
      : 'Enter the country',

    lossType: isHealthClaim
      ? 'Select the type of medical treatment'
      : isTravelMedicalClaim
        ? 'Select the overseas medical emergency type'
        : 'Select a loss type',

    description: isHealthClaim
      ? 'Describe the illness or injury, symptoms, diagnosis and medical treatment (minimum 20 characters)'
      : isTravelMedicalClaim
        ? 'Describe the medical emergency abroad, symptoms, diagnosis and treatment received (minimum 20 characters)'
        : 'Describe what happened in at least 20 characters',

    amount: isHealthClaim
      ? 'Enter the estimated medical expenses'
      : isTravelMedicalClaim
        ? 'Enter the estimated overseas medical expenses'
        : 'Enter the estimated loss amount',

    positiveAmount: isHealthClaim
      ? 'Medical expenses must be greater than zero'
      : isTravelMedicalClaim
        ? 'Overseas medical expenses must be greater than zero'
        : 'Enter an amount greater than zero',

    asset: isHealthClaim
      ? 'Enter the patient or covered person name'
      : isTravelMedicalClaim
        ? 'Enter the patient or covered traveller name'
        : 'Describe the affected property or asset',
  }

  return z.object({
    policyNumber: z.string().min(1, 'Select the policy this claim is for'),

    insuredName: z.string().trim().min(2, messages.insuredName),

    lossDate: z.string()
      .min(1, messages.lossDate)
      .refine(
        (v) => !v || !Number.isNaN(new Date(v).getTime()),
        'Enter a valid date and time'
      )
      .refine(
        (v) =>
          !v ||
          Number.isNaN(new Date(v).getTime()) ||
          new Date(v).getTime() <= Date.now() + 60_000,
        messages.futureDate
      ),

    lossLocation: z.string()
      .trim()
      .min(3, messages.location)
      .max(500, 'Location must not exceed 500 characters'),

    lossCity: z.string()
      .trim()
      .min(2, messages.city),

    lossCountry: z.string()
      .trim()
      .min(2, messages.country),

    lossType: z.string().min(1, messages.lossType),

    lossDescription: z.string()
      .trim()
      .min(20, messages.description)
      .max(5000, 'Description must not exceed 5000 characters'),

    estimatedLoss: z.preprocess(
      (value) =>
        value === '' || value === null || value === undefined
          ? undefined
          : Number(value),
      z.number({
        invalid_type_error: messages.amount,
        required_error: messages.amount,
      })
        .positive(messages.positiveAmount)
        .max(1e11, 'Amount exceeds the permitted limit')
    ),

    affectedAsset: z.string()
      .trim()
      .min(2, messages.asset),

    contactName: z.string()
      .trim()
      .min(2, 'Enter a valid contact name'),

    contactPhone: z.string()
      .trim()
      .refine(
        (v) => indianMobileDigits(v) !== null,
        INDIAN_MOBILE_MESSAGE
      ),

    contactEmail: z.string()
      .trim()
      .email('Enter a valid email address'),

    declarationAccepted: z.boolean()
      .refine(
        (v) => v === true,
        'You must accept the declaration to submit'
      ),
  })
}

// Default schema for existing imports.
export const claimFormSchema = createClaimFormSchema()

export const STEP_FIELDS = {
  1: ['policyNumber', 'insuredName'],
  2: [
    'lossDate',
    'lossLocation',
    'lossCity',
    'lossCountry',
    'lossType',
    'lossDescription',
  ],
  3: ['estimatedLoss', 'affectedAsset'],
  4: [],
  5: ['contactName', 'contactPhone', 'contactEmail'],
  6: ['declarationAccepted'],
}

const SERVER_FIELD_TO_FORM = {
  policy_id: 'policyNumber',
  policy_number: 'policyNumber',
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
  return Number(
    Object.entries(STEP_FIELDS).find(
      ([, fields]) => fields.includes(field)
    )?.[0] || 1
  )
}

/** Converts form values to the API draft payload. */
export function toDraftPayload(values, step) {
  const text = (v) =>
    v === undefined || v === null || String(v).trim() === ''
      ? null
      : String(v).trim()

  return {
    policyNumber: text(values.policyNumber),
    lossDate: values.lossDate
      ? new Date(values.lossDate).toISOString()
      : null,
    lossLocation: text(values.lossLocation),
    lossCity: text(values.lossCity),
    lossCountry: text(values.lossCountry),
    lossType: text(values.lossType),
    lossDescription: text(values.lossDescription),
    estimatedLoss:
      values.estimatedLoss === '' || values.estimatedLoss == null
        ? null
        : Number(values.estimatedLoss),
    affectedAsset: text(values.affectedAsset),
    contactName: text(values.contactName),
    contactPhone: normalizeIndianMobile(values.contactPhone),
    contactEmail: text(values.contactEmail),
    declarationAccepted: Boolean(values.declarationAccepted),
    draftStep: step,
  }
}
