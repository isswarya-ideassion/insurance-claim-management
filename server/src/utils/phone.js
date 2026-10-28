import { z } from 'zod'
import { INDIAN_MOBILE_MESSAGE, indianMobileDigits, normalizeIndianMobile } from '../../../shared/constants.js'

/** Indian mobile number (with or without +91), stored as "+91 98765 43210". */
export const indianMobile = z
  .string()
  .trim()
  .refine((v) => indianMobileDigits(v) !== null, INDIAN_MOBILE_MESSAGE)
  .transform(normalizeIndianMobile)
