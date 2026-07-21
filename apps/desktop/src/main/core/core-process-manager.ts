import { EventEmitter } from 'node:events'
import type { CoreProcessState, CoreStatus } from '../../shared/core'
import type { Logger } from '../logging/logger'

export interface CoreProcessAdapter {
  start(signal: AbortSignal): Promise<void>
  stop(signal: AbortSignal): Promise<void>
  handshake(signal: AbortSignal): Promise<void>
  health(signal: AbortSignal): Promise<boolean>
}

export class MockCoreProcessAdapter implements CoreProcessAdapter {
  start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }
  stop(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }
  handshake(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return Promise.resolve()
  }
  health(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return Promise.resolve(true)
  }
}

export class CoreProcessManager extends EventEmitter {
  private state: CoreProcessState = 'stopped'
  private startedAt: number | undefined
  private lastError: string | undefined

  constructor(
    private readonly adapter: CoreProcessAdapter,
    private readonly log: Logger,
    private readonly startTimeoutMs = 10_000,
    private readonly stopTimeoutMs = 5_000
  ) {
    super()
  }

  get status(): CoreStatus {
    const status: CoreStatus = { state: this.state, implementation: 'mock' }
    if (this.startedAt !== undefined) status.startedAt = this.startedAt
    if (this.lastError !== undefined) status.lastError = this.lastError
    return status
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return
    this.setState('starting')
    try {
      await withTimeout(this.startTimeoutMs, (signal) => this.adapter.start(signal))
      await withTimeout(this.startTimeoutMs, (signal) => this.adapter.handshake(signal))
      this.startedAt = Date.now()
      this.lastError = undefined
      this.setState('running')
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('failed')
      this.log.error('core-process', 'Core start failed', error)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return
    this.setState('stopping')
    try {
      await withTimeout(this.stopTimeoutMs, (signal) => this.adapter.stop(signal))
    } finally {
      this.startedAt = undefined
      this.setState('stopped')
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async health(): Promise<boolean> {
    if (this.state !== 'running') return false
    return withTimeout(this.startTimeoutMs, (signal) => this.adapter.health(signal))
  }

  routeStdout(message: string): void {
    this.log.info('core-stdout', message)
    this.emit('stdout', message)
  }

  routeStderr(message: string): void {
    this.log.warn('core-stderr', message)
    this.emit('stderr', message)
  }

  routeExit(code: number | null): void {
    this.startedAt = undefined
    this.lastError = `Core exited unexpectedly (${String(code)})`
    this.setState('failed')
    this.emit('exit', code)
  }

  private setState(state: CoreProcessState): void {
    this.state = state
    this.log.info('core-process', `State changed to ${state}`)
    this.emit('status', this.status)
  }
}

async function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
