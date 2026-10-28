import { createHash } from 'node:crypto'
import { AppError, notFound } from '../utils/errors.js'

/**
 * Private document storage in PostgreSQL (public.document_files). Objects are
 * write-once and never exposed by URL: downloads are streamed through the API
 * after an access check. Pass a transaction-scoped repository as `t` to store
 * the file in the same transaction as its metadata.
 */
export function createDatabaseStorage(db) {
  return {
    kind: 'postgres',
    async put(storageKey, buffer, contentType, t = db) {
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      try {
        await t.query(
          `insert into public.document_files (storage_key, content, mime_type, size_bytes, sha256)
           values ($1, $2, $3, $4, $5)`,
          [storageKey, buffer, contentType, buffer.length, sha256],
        )
      } catch (err) {
        if (err.code === 'DUPLICATE') throw new AppError(409, 'STORAGE_KEY_EXISTS', 'A file is already stored under this key')
        throw err
      }
    },
    async get(storageKey) {
      const rows = await db.query('select content, sha256 from public.document_files where storage_key = $1', [storageKey])
      if (!rows[0]) throw notFound('Stored file not found')
      const content = Buffer.from(rows[0].content)
      if (createHash('sha256').update(content).digest('hex') !== rows[0].sha256) {
        throw new AppError(500, 'STORAGE_INTEGRITY_ERROR', 'Stored file failed its integrity check')
      }
      return content
    },
  }
}
