import { z } from 'zod'

export const reportQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    granularity: z.enum(['day', 'week', 'month']).default('week'),
  })
  .transform((q) => {
    const to = q.to ? new Date(new Date(q.to).getTime() + 86_399_999) : new Date()
    const from = q.from || new Date(to.getTime() - 180 * 86_400_000)
    return { ...q, from, to }
  })
  .refine((q) => q.from <= q.to, { message: '"from" must be before "to"', path: ['from'] })
