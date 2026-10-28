import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { authenticate } from '../middleware/auth.js'
import { ok } from '../utils/http.js'
import { authRoutes } from '../modules/auth/auth.routes.js'
import { policiesRoutes } from '../modules/policies/policies.routes.js'
import { claimsRoutes } from '../modules/claims/claims.routes.js'
import { assignmentsRoutes } from '../modules/assignments/assignments.routes.js'
import { documentsRoutes } from '../modules/documents/documents.routes.js'
import { tasksRoutes } from '../modules/tasks/tasks.routes.js'
import { evaluationsRoutes } from '../modules/evaluations/evaluations.routes.js'
import { reservesRoutes } from '../modules/reserves/reserves.routes.js'
import { settlementsRoutes } from '../modules/settlements/settlements.routes.js'
import { complianceRoutes } from '../modules/compliance/compliance.routes.js'
import { paymentsRoutes } from '../modules/payments/payments.routes.js'
import { notificationsRoutes } from '../modules/notifications/notifications.routes.js'
import { reportsRoutes } from '../modules/reports/reports.routes.js'
import { auditRoutes } from '../modules/audit/audit.routes.js'
import { adminRoutes } from '../modules/admin/admin.routes.js'
import { customersRoutes } from '../modules/customers/customers.routes.js'
import { automationRoutes } from '../modules/automation/automation.routes.js'
import { closureRoutes } from '../modules/closure/closure.routes.js'
import { configRoutes } from '../modules/config/config.routes.js'
import { integrationsRoutes } from '../modules/integrations/integrations.routes.js'

export function createApiRouter(config) {
  const router = Router()

  router.get('/health', (req, res) =>
    ok(res, {
      status: 'ok',
      database: 'postgres',
      demoData: config.demoData,
      simulatedPayments: true,
      aiConfigured: config.AI_PROVIDER !== 'none',
      time: new Date().toISOString(),
    }),
  )

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.AUTH_RATE_LIMIT ?? (config.isTest ? 10_000 : config.isProduction ? 30 : 300),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait and try again.' } },
  })

  router.use(authRoutes({ authLimiter }))

  // Every route registered below requires a valid session.
  router.use(authenticate)
  router.use(policiesRoutes())
  router.use(claimsRoutes())
  router.use(assignmentsRoutes())
  router.use(documentsRoutes())
  router.use(tasksRoutes())
  router.use(evaluationsRoutes())
  router.use(reservesRoutes())
  router.use(settlementsRoutes())
  router.use(complianceRoutes())
  router.use(paymentsRoutes())
  router.use(notificationsRoutes())
  router.use(reportsRoutes())
  router.use(auditRoutes())
  router.use(adminRoutes())
  router.use(customersRoutes())
  router.use(automationRoutes())
  router.use(closureRoutes())
  router.use(configRoutes())
  router.use(integrationsRoutes())

  return router
}
