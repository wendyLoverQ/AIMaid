import { CORE_PROTOCOL_VERSION, isRecord } from '../../../shared/core'

export interface CoreProtocolError {
  code: string
  message: string
  details: Record<string, unknown>
}

export interface CoreRequestEnvelope {
  protocolVersion: typeof CORE_PROTOCOL_VERSION
  id: string
  kind: 'request'
  type: string
  timestamp: string
  payload: unknown
}

export interface CoreResponseEnvelope {
  protocolVersion: typeof CORE_PROTOCOL_VERSION
  id: string
  kind: 'response'
  type: string
  timestamp: string
  success: boolean
  payload: unknown
  error: CoreProtocolError | null
}

export interface CoreEventEnvelope {
  protocolVersion: typeof CORE_PROTOCOL_VERSION
  id: string
  kind: 'event'
  type: string
  timestamp: string
  correlationId: string | null
  sequence: number
  payload: unknown
}

export type IncomingCoreEnvelope = CoreResponseEnvelope | CoreEventEnvelope

export function createCoreRequest(id: string, type: string, payload: unknown): CoreRequestEnvelope {
  return { protocolVersion: CORE_PROTOCOL_VERSION, id, kind: 'request', type, timestamp: new Date().toISOString(), payload }
}

export function parseCoreLine(line: string): IncomingCoreEnvelope {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new CoreProtocolViolation('PROTOCOL_INVALID_JSON', 'Core stdout 包含非法 JSON。')
  }
  if (!isRecord(value) || value.protocolVersion !== CORE_PROTOCOL_VERSION) {
    throw new CoreProtocolViolation('PROTOCOL_VERSION_MISMATCH', 'Core 协议版本不兼容。')
  }
  if (!validBase(value)) throw new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core 消息缺少必需字段。')
  if (value.kind === 'response') {
    if (typeof value.success !== 'boolean' || !('payload' in value) || !validError(value.error)) {
      throw new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core response 结构无效。')
    }
    return value as unknown as CoreResponseEnvelope
  }
  if (value.kind === 'event') {
    if ((value.correlationId !== null && typeof value.correlationId !== 'string') ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !('payload' in value)) {
      throw new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core event 结构无效。')
    }
    return value as unknown as CoreEventEnvelope
  }
  throw new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core 只能输出 response 或 event。')
}

export class CoreProtocolViolation extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CoreProtocolViolation'
  }
}

function validBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' && value.id.length >= 8 && value.id.length <= 100 &&
    typeof value.type === 'string' && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/u.test(value.type) &&
    typeof value.timestamp === 'string' && !Number.isNaN(Date.parse(value.timestamp)) &&
    (value.kind === 'response' || value.kind === 'event')
  )
}

function validError(value: unknown): boolean {
  return value === null || (
    isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string' && isRecord(value.details)
  )
}
