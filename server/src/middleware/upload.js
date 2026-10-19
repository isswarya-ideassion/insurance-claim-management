import multer from 'multer'
import { MAX_UPLOAD_BYTES } from '../../../shared/constants.js'

export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
}).single('file')
