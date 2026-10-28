// Shared by the global setup and the per-file test context.

export const PASSWORD = 'Test-Password-123'

/** Configuration every test database is built and run with. */
export const TEST_SETTINGS = {
  NODE_ENV: 'test',
  AUTH_TOKEN_SECRET: 'test-only-secret-value-0123456789-abcdef',
  SEED_DEMO_DATA: 'true',
  DEMO_PASSWORD: PASSWORD,
  EMAIL_ADAPTER: 'console',
  OVERDUE_SWEEP_MINUTES: '0',
  DATABASE_SSL: 'disable',
}

/** Connection to an existing database on the test server (used to create and drop test databases). */
export function adminUrl() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error(
      'Set TEST_DATABASE_URL to a PostgreSQL server the tests may create databases on, ' +
        'e.g. TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres',
    )
  }
  return url
}

/** The same server and credentials as TEST_DATABASE_URL, with another database name. */
export function databaseUrl(name) {
  const url = new URL(adminUrl())
  url.pathname = `/${name}`
  return url.toString()
}
