import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import { authenticate } from '../../middleware/auth.js'
import * as controller from './auth.controller.js'
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.validators.js'

export function authRoutes({ authLimiter }) {
  const router = Router()

  router.get('/auth/me', authenticate, controller.me)
  router.patch('/auth/me', authenticate, validate({ body: updateProfileSchema }), controller.updateMe)

  // Mock-mode authentication (404 MOCK_AUTH_DISABLED when DATA_MODE=supabase).
  router.post('/auth/mock/login', authLimiter, validate({ body: loginSchema }), controller.mockLogin)
  router.post('/auth/mock/register', authLimiter, validate({ body: registerSchema }), controller.mockRegister)
  router.post('/auth/mock/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), controller.mockForgotPassword)
  router.post('/auth/mock/reset-password', authLimiter, validate({ body: resetPasswordSchema }), controller.mockResetPassword)

  return router
}
