import { z } from 'zod'
import { CONSENT_TYPES } from '../../../../shared/constants.js'
import { indianMobile } from '../../utils/phone.js'

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254)

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/[0-9]/, 'Password needs a number')

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(128),
})

export const registerSchema = z.object({
  email,
  password: passwordSchema,
  fullName: z.string().trim().min(2, 'Enter your full name').max(120),
  phone: z.literal('').transform(() => undefined).or(indianMobile).optional(),
  acceptPrivacyNotice: z.literal(true, { message: 'You must accept the privacy notice to register' }),
})

export const forgotPasswordSchema = z.object({ email })

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
})

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.literal('').transform(() => null).or(indianMobile).nullable().optional(),
})

export const consentSchema = z.object({
  consentType: z.enum(CONSENT_TYPES.filter((c) => c !== 'CLAIM_DECLARATION')),
  granted: z.boolean(),
})
