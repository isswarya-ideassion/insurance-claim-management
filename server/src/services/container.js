import { createDatabase } from '../db/index.js'
import { createEmailService } from './email.service.js'
import { createSimulatedPaymentAdapter } from './paymentAdapter.js'
import { createAiProvider } from './ai.service.js'
import { createFieldCrypto, encryptLegacyFields } from './crypto.service.js'
import { createDatabaseStorage } from './storage.service.js'
import { createPasswordAuthProvider } from './authProvider.js'
import { demoDataExists, ensureDemoUsers, seedDemoData } from '../seed/demoData.js'
import { logger } from '../config/logger.js'

/** Wires the PostgreSQL database, sign-in, document storage and the other adapters. */
export async function createDependencies(config, { seed = config.demoData } = {}) {
  const db = await createDatabase(config, { log: (msg) => logger.info(`[migrate] ${msg}`) })
  const email = createEmailService(config)
  const payments = createSimulatedPaymentAdapter()
  const ai = createAiProvider(config)
  const crypto = createFieldCrypto(config.fieldEncryptionKey)
  const authProvider = createPasswordAuthProvider(config, db, email)
  const storage = createDatabaseStorage(db)

  // Rows converted by the PRD migration (or imported from Supabase) may still hold plain text.
  await encryptLegacyFields(db, crypto)

  if (seed) {
    const seedOptions = {
      db,
      storage,
      crypto,
      password: config.DEMO_PASSWORD,
      createUser: (u) => authProvider.createUser(u),
      log: (msg) => logger.info(`[demo seed] ${msg}`),
    }
    if (!(await demoDataExists(db))) await seedDemoData(seedOptions)
    // Demo databases created before a new demo role was added get its account too.
    else await ensureDemoUsers(seedOptions)
  }

  return { config, db, email, payments, ai, crypto, authProvider, storage }
}
