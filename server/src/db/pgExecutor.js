import pg from 'pg'

// numeric -> Number (amounts fit comfortably in double precision at numeric(14,2));
// date -> 'YYYY-MM-DD' string so calendar dates are never shifted by time zones.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)))
pg.types.setTypeParser(1082, (v) => v)
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))

export function createPgExecutor({ connectionString, ssl }) {
  const pool = new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
  })

  return {
    kind: 'postgres',
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await fn({ query: (text, params) => client.query(text, params) })
        await client.query('commit')
        return result
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}
