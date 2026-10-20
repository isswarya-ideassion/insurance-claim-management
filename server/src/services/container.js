import { createDatabase } from '../db/index.js'
import { createEmailService } from './email.service.js'
import { createSimulatedPaymentAdapter } from './paymentAdapter.js'
import { createAiProvider } from './ai.service.js'
import { createLocalStorage, createSupabaseStorage } from './storage.service.js'
import { createMockAuthProvider, createSupabaseAuthProvider } from './authProvider.js'
import { demoDataExists, ensureDemoUsers, seedDemoData } from '../seed/demoData.js'
import { logger } from '../config/logger.js'

/** Wires adapters for the configured mode. Mock mode is never selected implicitly. */
export async function createDependencies(config, { seed = true } = {}) {
  const db = await createDatabase(config)
  const email = createEmailService(config)
  const payments = createSimulatedPaymentAdapter()
  const ai = createAiProvider(config)

  let authProvider
  let storage
  if (config.DATA_MODE === 'supabase') {
    authProvider = await createSupabaseAuthProvider(config)
    storage = createSupabaseStorage(authProvider.admin, config.SUPABASE_STORAGE_BUCKET)
  } else {
    authProvider = createMockAuthProvider(config, db, email)
    storage = createLocalStorage(config.mock.uploadsDir)
    const seedOptions = {
      db,
      storage,
      password: config.MOCK_DEMO_PASSWORD,
      createUser: (u) => authProvider.createUser(u),
      log: (msg) => logger.info(`[mock seed] ${msg}`),
    }
    if (seed && !(await demoDataExists(db))) await seedDemoData(seedOptions)
    // Demo databases created before a new demo role was added get its account too.
    else if (seed) await ensureDemoUsers(seedOptions)
  }

  return { config, db, email, payments, ai, authProvider, storage }
}
