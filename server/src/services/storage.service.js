import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, notFound } from '../utils/errors.js'

/** Private object storage in a Supabase bucket. Objects are never exposed by public URL. */
export function createSupabaseStorage(supabaseAdmin, bucket) {
  return {
    kind: 'supabase',
    async put(objectPath, buffer, contentType) {
      const { error } = await supabaseAdmin.storage.from(bucket).upload(objectPath, buffer, {
        contentType,
        upsert: false,
      })
      if (error) throw new AppError(502, 'STORAGE_ERROR', `Could not store file: ${error.message}`)
    },
    async get(objectPath) {
      const { data, error } = await supabaseAdmin.storage.from(bucket).download(objectPath)
      if (error || !data) throw notFound('Stored file not found')
      return Buffer.from(await data.arrayBuffer())
    },
  }
}

/** MOCK MODE: files are written to a gitignored local directory. */
export function createLocalStorage(rootDir) {
  const resolve = (objectPath) => {
    const full = path.resolve(rootDir, objectPath)
    if (!full.startsWith(path.resolve(rootDir) + path.sep)) throw new AppError(400, 'INVALID_PATH', 'Invalid storage path')
    return full
  }
  return {
    kind: 'local',
    async put(objectPath, buffer) {
      const full = resolve(objectPath)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, buffer, { flag: 'wx' })
    },
    async get(objectPath) {
      try {
        return await readFile(resolve(objectPath))
      } catch {
        throw notFound('Stored file not found')
      }
    },
  }
}
