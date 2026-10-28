/**
 * Vercel Function entry for the Express API (all of /api/v1 is rewritten here,
 * see vercel.json). One app, with its database pool, is created per function
 * instance on the first request and reused while the instance stays warm.
 *
 * Differences from the long-running server (server/src/server.js):
 * - migrations run as a deploy step (npm run db:migrate), never on a request;
 * - scheduled jobs run through GET /api/v1/internal/cron/jobs (Vercel Cron);
 * - uploads are capped at 4 MB because Vercel accepts requests up to 4.5 MB;
 * - a small database pool, since many instances may run at once.
 */
const SERVERLESS_DEFAULTS = {
  DB_MIGRATE_ON_START: 'false',
  OVERDUE_SWEEP_MINUTES: '0',
  MAX_UPLOAD_MB: '4',
  DATABASE_POOL_MAX: '3',
}

let appPromise

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      // Set before the server modules load: the upload limit is read at import time.
      for (const [key, value] of Object.entries(SERVERLESS_DEFAULTS)) process.env[key] ??= value
      process.env.DB_MIGRATE_ON_START = 'false'
      process.env.OVERDUE_SWEEP_MINUTES = '0'
      const [{ loadConfig }, { createDependencies }, { createApp }] = await Promise.all([
        import('../server/src/config/env.js'),
        import('../server/src/services/container.js'),
        import('../server/src/app.js'),
      ])
      const deps = await createDependencies(loadConfig())
      return createApp(deps)
    })().catch((err) => {
      appPromise = null
      throw err
    })
  }
  return appPromise
}

export default async function handler(req, res) {
  let app
  try {
    app = await getApp()
  } catch (err) {
    // Configuration and connection errors are logged, never returned (they can name settings).
    console.error('API failed to start:', err.message)
    res.statusCode = 503
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: { code: 'API_UNAVAILABLE', message: 'The service is starting up or misconfigured. Try again shortly.' } }))
    return
  }
  return app(req, res)
}
