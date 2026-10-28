import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { loadConfig } from '../src/config/env.js'
import { createDependencies } from '../src/services/container.js'
import { TEST_SETTINGS, adminUrl, databaseUrl } from './test-db.js'

/**
 * Runs once per test run: builds a template database with every migration and
 * the demo data, so each test file can clone it in milliseconds instead of
 * migrating and seeding its own database. Needs TEST_DATABASE_URL pointing at
 * a PostgreSQL server where that user may create databases and roles.
 */
export default async function setup({ provide }) {
  const template = `hp_test_template_${randomBytes(4).toString('hex')}`
  const admin = new pg.Client({ connectionString: adminUrl() })
  await admin.connect()
  try {
    // UTF-8 regardless of the server default (a Windows initdb defaults to WIN1252, which cannot store ₹).
    await admin.query(`create database ${template} encoding 'UTF8' template template0 lc_collate 'C' lc_ctype 'C'`)
  } finally {
    await admin.end()
  }

  const deps = await createDependencies(loadConfig({ ...TEST_SETTINGS, DATABASE_URL: databaseUrl(template) }), { seed: true })
  await deps.db.close()
  provide('templateDatabase', template)

  return async () => {
    const client = new pg.Client({ connectionString: adminUrl() })
    await client.connect()
    try {
      // Drop every database this run created (template and per-file clones).
      const { rows } = await client.query(`select datname from pg_database where datname like $1 or datname = $2`, [`${template}_%`, template])
      for (const r of rows) await client.query(`drop database if exists ${r.datname} with (force)`)
    } finally {
      await client.end()
    }
  }
}
