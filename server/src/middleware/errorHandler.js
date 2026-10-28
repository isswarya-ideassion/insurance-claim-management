import multer from 'multer'
import { ZodError } from 'zod'
import { AppError, fromDatabaseError } from '../utils/errors.js'
import { logger } from '../config/logger.js'
import { uploadLimitBytes } from './upload.js'

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, requestId: req.id },
  })
}

export function errorHandler(err, req, res, next) {
  let error = fromDatabaseError(err)

  if (error instanceof ZodError) {
    error = new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', formatZod(error))
  } else if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE' ? `File exceeds the ${uploadLimitBytes / 1024 / 1024} MB limit` : error.message
    error = new AppError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_REJECTED', message)
  } else if (error?.type === 'entity.parse.failed') {
    error = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  } else if (error?.type === 'entity.too.large') {
    error = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
  }

  if (!(error instanceof AppError)) {
    logger.error('unhandled error', { requestId: req.id, error: err?.message, stack: err?.stack })
    error = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred')
  } else if (error.status >= 500) {
    logger.error('server error', { requestId: req.id, code: error.code, error: error.message })
  }

  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      requestId: req.id,
    },
  })
}

function formatZod(err) {
  return err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
}
