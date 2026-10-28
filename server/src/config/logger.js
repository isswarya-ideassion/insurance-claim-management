const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

function defaultLevel() {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info'
}

function write(level, message, meta) {
  const threshold = LEVELS[defaultLevel()] ?? LEVELS.info
  if (LEVELS[level] < threshold) return
  const entry = { time: new Date().toISOString(), level, msg: message, ...(meta || {}) }
  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
}
