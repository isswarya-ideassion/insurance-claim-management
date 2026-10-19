import { z } from 'zod'

export function ok(res, data, meta, status = 200) {
  const body = { data }
  if (meta) body.meta = meta
  return res.status(status).json(body)
}

export function created(res, data, meta) {
  return ok(res, data, meta, 201)
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export function pageMeta({ page, pageSize }, total) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export function toOffset({ page, pageSize }) {
  return { limit: pageSize, offset: (page - 1) * pageSize }
}
