import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Builds one migrated, seeded template database on TEST_DATABASE_URL; each file clones it.
    globalSetup: ['tests/global-setup.js'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
})
