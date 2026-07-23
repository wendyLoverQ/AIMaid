import { randomUUID } from 'node:crypto'
import type { CoreHandshake, CoreRequest, CoreStatus } from '../../shared/core'
import { CORE_LONG_REQUEST_TIMEOUT_MS, CORE_PROTOCOL_VERSION, coreRequestTimeoutMs, isCoreEventType, isRecord } from '../../shared/core'
import type { IpcEventEnvelope } from '../../shared/ipc'
import type { Logger } from '../logging/logger'
import type { CoreClient, CoreEventListener } from './core-client'
import { CoreProtocolViolation, createCoreRequest, parseCoreLine } from './protocol/envelope'
import type { CoreEventEnvelope, CoreResponseEnvelope } from './protocol/envelope'

interface PendingRequest {
  type: string
  startedAt: number
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

export interface CoreClientTransport {
  readonly status: CoreStatus
  on(event: 'line', listener: (line: string) => void): unknown
  on(event: 'exit', listener: () => void): unknown
  off(event: 'line', listener: (line: string) => void): unknown
  off(event: 'exit', listener: () => void): unknown
  markReady(handshake: CoreHandshake): void
  expectExit(): void
  failSession?(error: Error): void
  writeLine(line: string): void
  health(): boolean
}

export interface CoreClientTimeouts {
  handshake: number
  request: number
  longRequest?: number
  cancel: number
  shutdown: number
}

const DEFAULT_TIMEOUTS: CoreClientTimeouts = {
  handshake: 8_000,
  request: coreRequestTimeoutMs('system.health'),
  longRequest: CORE_LONG_REQUEST_TIMEOUT_MS,
  cancel: 5_000,
  shutdown: 3_000
}

export class StdioCoreClient implements CoreClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly completedIds = new Map<string, number>()
  private readonly listeners = new Set<CoreEventListener>()
  private readonly sequences = new Map<string, number>()
  private started = false

  constructor(
    private readonly processManager: CoreClientTransport,
    private readonly desktopVersion: string,
    private readonly log: Logger,
    private readonly timeouts: CoreClientTimeouts = DEFAULT_TIMEOUTS
  ) {}

  async start(): Promise<void> {
    if (this.started) return
    this.detach()
    this.resetSessionState()
    const startedAt = performance.now()
    this.log.info('core-client', 'Core handshake started', {
      protocolVersion: CORE_PROTOCOL_VERSION,
      desktopVersion: this.desktopVersion,
      platform: process.platform,
      arch: process.arch
    })
    this.processManager.on('line', this.handleLine)
    this.processManager.on('exit', this.handleExit)
    try {
      const payload = await this.invokeRaw(randomUUID(), 'system.handshake', {
        desktopVersion: this.desktopVersion,
        platform: process.platform,
        arch: process.arch
      }, this.timeouts.handshake)
      const handshake = readHandshake(payload)
      if (handshake.protocolVersion !== CORE_PROTOCOL_VERSION) {
        throw new CoreProtocolViolation('PROTOCOL_VERSION_MISMATCH', 'Core handshake 协议版本不兼容。')
      }
      this.processManager.markReady(handshake)
      this.started = true
      this.log.info('core-client', 'Core handshake completed', {
        coreVersion: handshake.coreVersion,
        protocolVersion: handshake.protocolVersion,
        capabilities: handshake.capabilities,
        durationMs: elapsedMs(startedAt)
      })
    } catch (error) {
      this.detach()
      this.log.error('core-client', 'Core handshake failed', error, { durationMs: elapsedMs(startedAt) })
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.started && this.processManager.health()) {
      this.processManager.expectExit()
      try {
        await this.invokeRaw(randomUUID(), 'system.shutdown', {}, this.timeouts.shutdown)
      } catch (error) {
        this.log.warn('core-client', 'Core graceful shutdown request failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.started = false
    this.rejectAll(new CoreClientError('CORE_EXITED', 'Core client stopped.'))
    this.detach()
    this.resetSessionState()
  }

  invoke(requestId: string, request: CoreRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.started || !this.processManager.health()) {
      return Promise.reject(new CoreClientError('CORE_NOT_READY', 'Core 尚未 Ready。'))
    }
    return this.invokeRaw(requestId, request.type, request.payload, this.requestTimeoutMs(request.type), signal)
  }

  async cancel(requestId: string): Promise<void> {
    if (!this.started || !this.processManager.health()) throw new CoreClientError('CORE_NOT_READY', 'Core 尚未 Ready。')
    await this.invokeRaw(randomUUID(), 'system.cancel', { requestId }, this.timeouts.cancel)
    this.log.info('core-client', 'Cancellation sent', { requestId })
  }

  getStatus(): CoreStatus {
    return this.processManager.status
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private invokeRaw(id: string, type: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    this.pruneCompletedIds()
    if (this.pending.has(id) || this.completedIds.has(id)) {
      return Promise.reject(new CoreClientError('PROTOCOL_DUPLICATE_REQUEST', 'Core requestId 已经使用。'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.finishPending(id)) return
        reject(new CoreClientError('REQUEST_TIMEOUT', `${type} 请求超时。`))
        this.log.warn('core-client', 'Core request timed out', { requestId: id, type, timeoutMs })
        if (this.started && type !== 'system.cancel' && type !== 'system.shutdown' && type !== 'system.handshake') {
          void this.cancel(id).catch((error: unknown) => this.log.error('core-client', 'Timed-out Core cancellation failed', error))
        }
      }, timeoutMs)
      const pending: PendingRequest = { type, startedAt: performance.now(), resolve, reject, timer }
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (!this.finishPending(id)) return
          reject(new CoreClientError('REQUEST_CANCELLED', '请求已取消。'))
          if (this.started) void this.cancel(id).catch((error: unknown) => this.log.error('core-client', 'Core cancellation failed', error))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, pending)
      this.log.info('core-client', 'Core request started', { requestId: id, type, timeoutMs, pendingCount: this.pending.size })
      try {
        this.processManager.writeLine(JSON.stringify(createCoreRequest(id, type, payload)))
      } catch (error) {
        this.finishPending(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private readonly handleLine = (line: string): void => {
    let envelope
    try {
      envelope = parseCoreLine(line)
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error(String(error)), line)
      return
    }
    if (envelope.kind === 'response') this.handleResponse(envelope)
    else this.handleEvent(envelope)
  }

  private handleResponse(response: CoreResponseEnvelope): void {
    const pending = this.pending.get(response.id)
    if (pending === undefined) {
      const status = this.completedIds.has(response.id) ? 'late or duplicate response' : 'unknown response id'
      this.log.warn('core-protocol', status, { requestId: response.id, type: response.type })
      return
    }
    if (pending.type !== response.type) {
      this.finishPending(response.id)
      pending.reject(new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core response type 与请求不匹配。'))
      return
    }
    this.finishPending(response.id)
    const durationMs = elapsedMs(pending.startedAt)
    if (response.success) {
      pending.resolve(response.payload)
      this.log.info('core-client', 'Core request completed', {
        requestId: response.id,
        type: response.type,
        success: true,
        durationMs,
        pendingCount: this.pending.size
      })
    } else {
      const error = new CoreRemoteError(
        response.error?.code ?? 'INTERNAL_ERROR',
        response.error?.message ?? 'Core 请求失败。',
        response.error?.details ?? {}
      )
      pending.reject(error)
      this.log.error('core-client', 'Core request failed', error, {
        requestId: response.id,
        type: response.type,
        success: false,
        durationMs,
        pendingCount: this.pending.size
      })
    }
  }

  private handleEvent(event: CoreEventEnvelope): void {
    if (!isCoreEventType(event.type)) {
      this.log.warn('core-protocol', 'Unknown Core event type', { type: event.type })
      return
    }
    if (event.correlationId !== null) {
      const previous = this.sequences.get(event.correlationId) ?? -1
      if (event.sequence <= previous) {
        this.log.warn('core-protocol', 'Out-of-order Core event rejected', {
          correlationId: event.correlationId,
          sequence: event.sequence,
          previous
        })
        return
      }
      this.sequences.set(event.correlationId, event.sequence)
      if (event.type.endsWith('.completed') || event.type.endsWith('.cancelled')) this.sequences.delete(event.correlationId)
    }
    const ipcEvent: IpcEventEnvelope = {
      requestId: event.id,
      type: event.type,
      payload: { correlationId: event.correlationId, sequence: event.sequence, data: event.payload },
      success: true,
      error: null,
      timestamp: Date.parse(event.timestamp)
    }
    this.log.debug('core-client', 'Core event received', {
      eventId: event.id,
      type: event.type,
      correlationId: event.correlationId,
      sequence: event.sequence
    })
    for (const listener of this.listeners) listener(ipcEvent)
  }

  private readonly handleExit = (): void => {
    const pendingCount = this.pending.size
    this.started = false
    this.rejectAll(new CoreClientError('CORE_EXITED', 'Core 进程已经退出。'))
    this.detach()
    this.resetSessionState()
    this.log.warn('core-client', 'Core process exited', { pendingCount })
  }

  private requestTimeoutMs(type: CoreRequest['type']): number {
    return coreRequestTimeoutMs(type) === CORE_LONG_REQUEST_TIMEOUT_MS
      ? this.timeouts.longRequest ?? this.timeouts.request
      : this.timeouts.request
  }

  private finishPending(id: string): boolean {
    const pending = this.pending.get(id)
    if (pending === undefined) return false
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.pending.delete(id)
    this.completedIds.set(id, Date.now())
    return true
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(error)
      this.pending.delete(id)
      this.completedIds.set(id, Date.now())
    }
  }

  private detach(): void {
    this.processManager.off('line', this.handleLine)
    this.processManager.off('exit', this.handleExit)
  }

  private pruneCompletedIds(): void {
    const cutoff = Date.now() - 60_000
    for (const [id, completedAt] of this.completedIds) if (completedAt < cutoff) this.completedIds.delete(id)
  }

  private resetSessionState(): void {
    this.completedIds.clear()
    this.sequences.clear()
  }

  private failProtocol(error: Error, line: string): void {
    if (!this.started && this.pending.size === 0) return
    this.log.error('core-protocol', 'Fatal Core stdout protocol violation', error, { line })
    this.started = false
    this.rejectAll(error)
    this.detach()
    this.resetSessionState()
    this.processManager.failSession?.(error)
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

export class CoreClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CoreClientError'
  }
}

export class CoreRemoteError extends CoreClientError {
  constructor(code: string, message: string, readonly details: Record<string, unknown>) {
    super(code, message)
    this.name = 'CoreRemoteError'
  }
}

function readHandshake(value: unknown): CoreHandshake {
  if (!isRecord(value) || typeof value.coreVersion !== 'string' || value.protocolVersion !== CORE_PROTOCOL_VERSION ||
    !Array.isArray(value.capabilities) || !value.capabilities.every((item) => typeof item === 'string') ||
    typeof value.platform !== 'string' || typeof value.arch !== 'string' || typeof value.desktopVersion !== 'string') {
    throw new CoreProtocolViolation('PROTOCOL_INVALID_ENVELOPE', 'Core handshake payload 无效。')
  }
  return {
    coreVersion: value.coreVersion,
    protocolVersion: value.protocolVersion,
    capabilities: value.capabilities,
    platform: value.platform,
    arch: value.arch,
    desktopVersion: value.desktopVersion
  }
}
