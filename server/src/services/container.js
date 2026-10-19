import { createDatabase } from '../db/index.js'
import { createEmailService } from './email.service.js'
import { createSimulatedPaymentAdapter } from './paymentAdapter.js'
import { createLocalStorage, createSupabaseStorage } from './storage.service.js'
import { createMockAuthProvider, createSupabaseAuthProvider } from './authProvider.js'
import { demoDataExists, seedDemoData } from '../seed/demoData.js'
import { logger } from '../config/logger.js'

/** Wires adapters for the configured mode. Mock mode is never selected implicitly. */
export async function createDependencies(config, { seed = true } = {}) {
  const db = await createDatabase(config)
  const email = createEmailService(config)
  const payments = createSimulatedPaymentAdapter()

  let authProvider
  let storage
  if (config.DATA_MODE === 'supabase') {
    authProvider = await createSupabaseAuthProvider(config)
    storage = createSupabaseStorage(authProvider.admin, config.SUPABASE_STORAGE_BUCKET)
  } else {
    authProvider = createMockAuthProvider(config, db, email)
    storage = createLocalStorage(config.mock.uploadsDir)
    if (seed && !(await demoDataExists(db))) {
      await seedDemoData({
        db,
        storage,
        password: config.MOCK_DEMO_PASSWORD,
        createUser: (u) => authProvider.createUser(u),
        log: (msg) => logger.info(`[mock seed] ${msg}`),
      })
    }
  }

  return { config, db, email, payments, authProvider, storage }
}
