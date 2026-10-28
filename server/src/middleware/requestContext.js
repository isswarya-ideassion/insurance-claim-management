import { randomUUID } from 'node:crypto'
import { logger } from '../config/logger.js'

export function requestId(req, res, next) {
  const incoming = req.get('x-request-id')
  req.id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID()
  res.set('x-request-id', req.id)
  next()
}

export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6
    logger.info('request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      userId: req.user?.id,
    })
  })
  next()
}
