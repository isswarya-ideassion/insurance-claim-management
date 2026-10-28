import { ok, created } from '../../utils/http.js'
import * as service from './auth.service.js'

const publicCtx = (req) => ({ ...req.app.locals.deps, requestId: req.id, ip: req.ip })

export async function me(req, res) {
  ok(res, await service.describeUser(req.ctx, req.user))
}

export async function updateMe(req, res) {
  const user = await service.updateProfile(req.ctx, req.body)
  ok(res, { id: user.id, fullName: user.full_name, phone: user.phone })
}

export async function consents(req, res) {
  ok(res, await service.listConsents(req.ctx))
}

export async function recordConsent(req, res) {
  created(res, await service.recordConsent(req.ctx, req.body))
}

export async function login(req, res) {
  ok(res, await service.login(publicCtx(req), req.body))
}

export async function register(req, res) {
  created(res, await service.register(publicCtx(req), req.body))
}

export async function forgotPassword(req, res) {
  const origin = req.app.locals.deps.config.clientOrigins[0]
  ok(res, await service.forgotPassword(publicCtx(req), req.body, `${origin}/reset-password`))
}

export async function resetPassword(req, res) {
  ok(res, await service.resetPassword(publicCtx(req), req.body))
}
