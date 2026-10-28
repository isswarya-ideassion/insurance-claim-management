import { assertTable, jsonColumns } from './schema.js'
import { buildOrderBy, buildWhere, ident } from './queryBuilder.js'
import { fromDatabaseError } from '../utils/errors.js'
import { logger } from '../config/logger.js'

function serialise(table, row) {
  const json = jsonColumns(table)
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue
    out[key] = json.includes(key) && value !== null ? JSON.stringify(value) : value
  }
  return out
}

/**
 * Small data-access layer over the node-postgres executor. `executor` must provide query(text, params) -> { rows }
 * and transaction(fn) where fn receives a transaction-scoped executor.
 */
export function createRepository(executor, { inTransaction = false, afterCommit = null } = {}) {
  const run = async (text, params = []) => {
    try {
      const result = await executor.query(text, params)
      return result.rows
    } catch (err) {
      throw fromDatabaseError(err)
    }
  }

  const repo = {
    inTransaction,

    query: run,

    async findMany(table, { where, orderBy, limit, offset, columns, forUpdate } = {}) {
      assertTable(table)
      const params = []
      const cols = columns ? columns.map(ident).join(', ') : '*'
      let sql = `select ${cols} from public.${ident(table)} where ${buildWhere(where, params)}${buildOrderBy(orderBy)}`
      if (limit != null) {
        params.push(Number(limit))
        sql += ` limit $${params.length}`
      }
      if (offset != null) {
        params.push(Number(offset))
        sql += ` offset $${params.length}`
      }
      if (forUpdate) sql += ' for update'
      return run(sql, params)
    },

    async findOne(table, where, options = {}) {
      const rows = await repo.findMany(table, { ...options, where, limit: 1 })
      return rows[0] || null
    },

    async findById(table, id, options = {}) {
      if (!id) return null
      return repo.findOne(table, { id }, options)
    },

    async count(table, where) {
      assertTable(table)
      const params = []
      const rows = await run(
        `select count(*)::int as count from public.${ident(table)} where ${buildWhere(where, params)}`,
        params,
      )
      return rows[0].count
    },

    async groupCount(table, column, where) {
      assertTable(table)
      const params = []
      const col = ident(column)
      const rows = await run(
        `select ${col} as key, count(*)::int as count from public.${ident(table)} where ${buildWhere(where, params)} group by ${col}`,
        params,
      )
      return Object.fromEntries(rows.map((r) => [r.key, r.count]))
    },

    async insert(table, data) {
      assertTable(table)
      const list = Array.isArray(data) ? data : [data]
      if (list.length === 0) return []
      const out = []
      for (const item of list) {
        const row = serialise(table, item)
        const keys = Object.keys(row)
        const params = keys.map((k) => row[k])
        const sql = keys.length
          ? `insert into public.${ident(table)} (${keys.map(ident).join(', ')}) values (${keys
              .map((_, i) => `$${i + 1}`)
              .join(', ')}) returning *`
          : `insert into public.${ident(table)} default values returning *`
        const rows = await run(sql, params)
        out.push(rows[0])
      }
      return Array.isArray(data) ? out : out[0]
    },

    async update(table, where, patch) {
      assertTable(table)
      const row = serialise(table, patch)
      const keys = Object.keys(row)
      if (keys.length === 0) return repo.findMany(table, { where })
      const params = keys.map((k) => row[k])
      const sets = keys.map((k, i) => `${ident(k)} = $${i + 1}`).join(', ')
      const sql = `update public.${ident(table)} set ${sets} where ${buildWhere(where, params)} returning *`
      return run(sql, params)
    },

    async updateById(table, id, patch) {
      const rows = await repo.update(table, { id }, patch)
      return rows[0] || null
    },

    async remove(table, where) {
      assertTable(table)
      const params = []
      return run(`delete from public.${ident(table)} where ${buildWhere(where, params)} returning *`, params)
    },

    /** Runs fn inside a database transaction; nested calls reuse the outer transaction. */
    async tx(fn) {
      if (inTransaction) return fn(repo)
      const hooks = []
      const result = await executor.transaction((txExecutor) =>
        fn(createRepository(txExecutor, { inTransaction: true, afterCommit: hooks })),
      )
      for (const hook of hooks) {
        try {
          await hook()
        } catch (err) {
          logger.warn('after-commit hook failed', { error: err.message })
        }
      }
      return result
    },

    /** Registers work to run only after the surrounding transaction commits. */
    afterCommit(hook) {
      if (afterCommit) afterCommit.push(hook)
      else Promise.resolve().then(hook).catch(() => {})
    },
  }
  return repo
}
