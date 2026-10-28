export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details)
export const validationError = (message, details) => new AppError(422, 'VALIDATION_ERROR', message, details)
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', message)
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
  new AppError(403, code, message)
export const notFound = (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message)
export const conflict = (message, code = 'CONFLICT', details) => new AppError(409, code, message, details)
export const businessRule = (code, message, details) => new AppError(409, code, message, details)

const TRIGGER_CODE = /^([A-Z_]+):\s*(.*)$/s

/** Converts Postgres errors (unique violations, check constraints, trigger exceptions) into AppErrors. */
export function fromDatabaseError(err) {
  if (!err || err instanceof AppError) return err
  switch (err.code) {
    case '23505':
      return conflict('A record with the same unique value already exists.', 'DUPLICATE', {
        constraint: err.constraint,
      })
    case '23514':
      return new AppError(422, 'CONSTRAINT_VIOLATION', `Database constraint failed: ${err.constraint || 'check'}`, {
        constraint: err.constraint,
      })
    case '23503':
      return new AppError(422, 'INVALID_REFERENCE', 'A referenced record does not exist.', {
        constraint: err.constraint,
      })
    case '22P02':
      return badRequest('Invalid identifier or value format.')
    case 'P0001': {
      const match = TRIGGER_CODE.exec(err.message || '')
      if (match) return businessRule(match[1], match[2])
      return businessRule('BUSINESS_RULE_VIOLATION', err.message)
    }
    default:
      return err
  }
}
