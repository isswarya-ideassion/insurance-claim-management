import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { authenticate } from '../../middleware/auth.js'
import * as controller from './auth.controller.js'
import {
  forgotPasswordSchema,
  consentSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.validators.js'

export function authRoutes({ authLimiter }) {
  const router = Router()

  router.get('/auth/me', authenticate, controller.me)
  router.patch('/auth/me', authenticate, validate({ body: updateProfileSchema }), controller.updateMe)
  router.get('/auth/me/consents', authenticate, controller.consents)
  router.post('/auth/me/consents', authenticate, validate({ body: consentSchema }), controller.recordConsent)

  // Email + password sign-in against the API's own credential store (auth.users).
  router.post('/auth/login', authLimiter, validate({ body: loginSchema }), controller.login)
  router.post('/auth/register', authLimiter, validate({ body: registerSchema }), controller.register)
  router.post('/auth/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword)
  router.post('/auth/reset-password', authLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword)

  return router
}
