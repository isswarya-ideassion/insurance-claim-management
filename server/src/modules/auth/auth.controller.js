import { ok, created } from '../../utils/http.js'
import * as service from './auth.service.js'

const publicCtx = (req) => ({ ...req.app.locals.deps, requestId: req.id, ip: req.ip })

export async function me(req, res) {
  ok(res, service.describeUser(req.user))
}

export async function updateMe(req, res) {
  const profile = await service.updateProfile(req.ctx, req.body)
  ok(res, { id: profile.id, fullName: profile.full_name, phone: profile.phone })
}

export async function mockLogin(req, res) {
  ok(res, await service.mockLogin(publicCtx(req), req.body))
}

export async function mockRegister(req, res) {
  created(res, await service.mockRegister(publicCtx(req), req.body))
}

export async function mockForgotPassword(req, res) {
  const origin = req.app.locals.deps.config.clientOrigins[0]
  ok(res, await service.mockForgotPassword(publicCtx(req), req.body, `${origin}/reset-password`))
}

export async function mockResetPassword(req, res) {
  ok(res, await service.mockResetPassword(publicCtx(req), req.body))
}
