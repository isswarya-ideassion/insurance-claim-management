import multer from 'multer'
import { MAX_UPLOAD_BYTES } from '../../../shared/constants.js'

/** Upload limit: MAX_UPLOAD_MB (1-10, default 10). Vercel functions need 4 because requests are capped at 4.5 MB. */
export const uploadLimitBytes = Math.min(MAX_UPLOAD_BYTES, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 10) * 1024 * 1024)

export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadLimitBytes, files: 1, fields: 10 },
}).single('file')
