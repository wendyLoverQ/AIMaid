export type CoreRequest =
  | { type: 'mock.echo'; payload: { message: string } }
  | { type: 'mock.health'; payload: Record<string, never> }

export type CoreEventType =
  | 'core.ready'
  | 'core.status-changed'
  | 'mock.message'
  | 'core.stdout'
  | 'core.stderr'
  | 'core.exit'

export type CoreProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface CoreStatus {
  state: CoreProcessState
  implementation: 'mock' | 'real'
  startedAt?: number
  lastError?: string
}

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) {
    return false
  }

  if (value.type === 'mock.health') {
    return Object.keys(value.payload).length === 0
  }

  return value.type === 'mock.echo' && typeof value.payload.message === 'string' && value.payload.message.length <= 2_000
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
