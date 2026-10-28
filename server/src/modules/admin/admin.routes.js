import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './admin.controller.js'
import { createUserSchema, grantRoleSchema, listUsersQuery, roleParams, updateUserSchema, userParams } from './admin.validators.js'

export function adminRoutes() {
  const router = Router()
  router.get('/admin/users', validate({ query: listUsersQuery }), controller.users)
  router.post('/admin/users', validate({ body: createUserSchema }), controller.createUser)
  router.patch('/admin/users/:id', validate({ params: userParams, body: updateUserSchema }), controller.updateUser)
  router.post('/admin/users/:id/roles', validate({ params: userParams, body: grantRoleSchema }), controller.grantRole)
  router.delete('/admin/users/:id/roles/:roleCode', validate({ params: roleParams }), controller.revokeRole)
  router.get('/admin/roles', controller.roles)
  router.get('/admin/system', controller.system)
  router.post('/admin/jobs/overdue-sweep', controller.overdueSweep)
  return router
}
