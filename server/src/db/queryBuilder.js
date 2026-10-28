const IDENT = /^[a-z_][a-z0-9_]*$/

export function ident(name) {
  if (!IDENT.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return `"${name}"`
}

const OPERATORS = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

/**
 * Translates a plain filter object into a parameterised SQL predicate.
 *   { status: 'OPEN' }                    -> "status" = $1
 *   { status: { in: ['A', 'B'] } }        -> "status" = any($1)
 *   { due_at: { lt: date }, x: null }     -> "due_at" < $1 and "x" is null
 *   { $or: [{...}, {...}] }               -> ( ... or ... )
 *   { name: { ilike: '%abc%' } }          -> "name" ilike $1
 */
export function buildWhere(where, params) {
  if (!where || Object.keys(where).length === 0) return 'true'
  const parts = []
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue
    if (key === '$or' || key === '$and') {
      const list = (value || []).filter(Boolean)
      if (list.length === 0) {
        parts.push(key === '$or' ? 'false' : 'true')
        continue
      }
      const joined = list.map((w) => `(${buildWhere(w, params)})`).join(key === '$or' ? ' or ' : ' and ')
      parts.push(`(${joined})`)
      continue
    }
    const col = ident(key)
    if (value === null) {
      parts.push(`${col} is null`)
    } else if (value instanceof Date || typeof value !== 'object' || Array.isArray(value)) {
      if (Array.isArray(value)) throw new Error(`Use { in: [...] } for array filters on ${key}`)
      params.push(value)
      parts.push(`${col} = $${params.length}`)
    } else {
      for (const [op, operand] of Object.entries(value)) {
        if (operand === undefined) continue
        if (op === 'in' || op === 'nin') {
          if (!Array.isArray(operand)) throw new Error(`${op} expects an array for ${key}`)
          if (operand.length === 0) {
            parts.push(op === 'in' ? 'false' : 'true')
            continue
          }
          params.push(operand)
          parts.push(op === 'in' ? `${col} = any($${params.length})` : `not (${col} = any($${params.length}))`)
        } else if (op === 'isNull') {
          parts.push(operand ? `${col} is null` : `${col} is not null`)
        } else if (op === 'ilike') {
          params.push(operand)
          parts.push(`${col}::text ilike $${params.length}`)
        } else if (op === 'ne' && operand === null) {
          parts.push(`${col} is not null`)
        } else if (OPERATORS[op]) {
          params.push(operand)
          parts.push(`${col} ${OPERATORS[op]} $${params.length}`)
        } else {
          throw new Error(`Unsupported operator "${op}" on ${key}`)
        }
      }
    }
  }
  return parts.length ? parts.join(' and ') : 'true'
}

export function buildOrderBy(orderBy) {
  if (!orderBy) return ''
  const list = Array.isArray(orderBy) ? orderBy : [orderBy]
  const parts = list.map((entry) => {
    const [column, direction = 'asc'] = Array.isArray(entry) ? entry : String(entry).trim().split(/\s+/)
    const dir = String(direction).toLowerCase()
    if (!['asc', 'desc'].includes(dir)) throw new Error(`Invalid sort direction: ${direction}`)
    return `${ident(column)} ${dir} nulls last`
  })
  return parts.length ? ` order by ${parts.join(', ')}` : ''
}

export function escapeLike(term) {
  return String(term).replace(/[\\%_]/g, (c) => `\\${c}`)
}
