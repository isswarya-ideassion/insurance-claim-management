import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { requestId, requestLogger } from './middleware/requestContext.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { createApiRouter } from './routes/index.js'

export function createApp(deps) {
  const app = express()
  app.locals.deps = deps
  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(helmet())
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || deps.config.clientOrigins.includes(origin)) return callback(null, true)
        return callback(null, false)
      },
      credentials: false,
      exposedHeaders: ['x-request-id', 'content-disposition'],
    }),
  )
  app.use(requestId)
  app.use(requestLogger)
  app.use(express.json({ limit: '1mb' }))

  app.use('/api/v1', createApiRouter(deps.config))

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
