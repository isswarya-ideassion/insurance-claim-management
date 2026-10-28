import { Router } from 'express'
import { validate } from '../../middleware/validate.js'
import * as controller from './tasks.controller.js'
import { createTaskSchema, idParams, listTasksQuery, updateTaskSchema } from './tasks.validators.js'

export function tasksRoutes() {
  const router = Router()
  router.get('/tasks', validate({ query: listTasksQuery }), controller.list)
  router.post('/tasks', validate({ body: createTaskSchema }), controller.create)
  router.patch('/tasks/:id', validate({ params: idParams, body: updateTaskSchema }), controller.update)
  router.get('/claims/:id/tasks', validate({ params: idParams }), controller.listForClaim)
  return router
}
