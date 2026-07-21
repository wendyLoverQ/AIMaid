export interface Logger {
  debug(scope: string, message: string, data?: Record<string, unknown>): void
  info(scope: string, message: string, data?: Record<string, unknown>): void
  warn(scope: string, message: string, data?: Record<string, unknown>): void
  error(scope: string, message: string, error?: unknown): void
}

function write(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, data?: unknown): void {
  const record = { timestamp: new Date().toISOString(), level, scope, message, data }
  const output = JSON.stringify(record)
  if (level === 'error') console.error(output)
  else if (level === 'warn') console.warn(output)
  else console.log(output)
}

export const logger: Logger = {
  debug: (scope, message, data) => write('debug', scope, message, data),
  info: (scope, message, data) => write('info', scope, message, data),
  warn: (scope, message, data) => write('warn', scope, message, data),
  error: (scope, message, error) => write('error', scope, message, normalizeError(error))
}

export function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}
