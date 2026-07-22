import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  debug(scope: string, message: string, data?: Record<string, unknown>): void
  info(scope: string, message: string, data?: Record<string, unknown>): void
  warn(scope: string, message: string, data?: Record<string, unknown>): void
  error(scope: string, message: string, error?: unknown, context?: Record<string, unknown>): void
}

const SENSITIVE_KEY = /(?:^|[_\-.])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credential|password|secret|private[_-]?key)(?:$|[_\-.])/iu
const SENSITIVE_QUERY = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password)=)[^&#\s]*/giu
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\-/=]+/giu
const EMBEDDED_SECRET = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|cookie|authorization)\s*[:=]\s*)([^\s,;&#]+)/giu
const MAX_DEPTH = 8

function write(level: 'debug' | 'info' | 'warn' | 'error', scope: string, message: string, data?: unknown): void {
  const record = { timestamp: new Date().toISOString(), level, scope, message, data: redact(data) }
  const output = JSON.stringify(record)
  if (logFilePath !== undefined) {
    try {
      appendFileSync(logFilePath, `${output}\n`, 'utf8')
    } catch (error) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        scope: 'logger',
        message: 'Failed to append application log',
        data: basicError(error)
      }))
    }
  }
  if (level === 'error') console.error(output)
  else if (level === 'warn') console.warn(output)
  else console.log(output)
}

let logFilePath: string | undefined

export function configureFileLogging(logRoot: string): string {
  mkdirSync(logRoot, { recursive: true })
  logFilePath = join(logRoot, 'aimaid-desktop.jsonl')
  return logFilePath
}

export const logger: Logger = {
  debug: (scope, message, data) => write('debug', scope, message, data),
  info: (scope, message, data) => write('info', scope, message, data),
  warn: (scope, message, data) => write('warn', scope, message, data),
  error: (scope, message, error, context) => write('error', scope, message, {
    ...context,
    error: normalizeError(error)
  })
}

export function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const normalized: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack }
    for (const key of Object.keys(error)) normalized[key] = (error as unknown as Record<string, unknown>)[key]
    return normalized
  }
  if (typeof error === 'object' && error !== null) {
    const details = { ...(error as Record<string, unknown>) }
    return { message: typeof details.message === 'string' ? details.message : 'Non-Error failure details', ...details }
  }
  return { message: String(error) }
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol') return value.description ?? '[SYMBOL]'
  if (typeof value === 'function') return `[FUNCTION:${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return '[UNKNOWN]'
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? '[REDACTED]' : redact(item, depth + 1, seen)
  }
  return result
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SENSITIVE_KEY.test(normalized) || /^(?:token|key|secret|password|cookie)$/iu.test(normalized)
}

function redactString(value: string): string {
  return value
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(BEARER_TOKEN, '$1 [REDACTED]')
    .replace(EMBEDDED_SECRET, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/giu, '$1[REDACTED]@')
}

function basicError(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }
}
