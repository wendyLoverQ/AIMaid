import { randomUUID } from 'node:crypto'
import type { CoreRequest } from '../../shared/core'
import type { IpcEventEnvelope } from '../../shared/ipc'
import type { CoreClient, CoreEventListener } from './core-client'

export class MockCoreClient implements CoreClient {
  private readonly listeners = new Set<CoreEventListener>()
  private started = false

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    this.started = true
    this.emit('core.ready', { implementation: 'mock' })
    return Promise.resolve()
  }

  stop(): Promise<void> {
    this.started = false
    this.listeners.clear()
    return Promise.resolve()
  }

  async invoke(requestId: string, request: CoreRequest, signal: AbortSignal): Promise<unknown> {
    if (!this.started) throw new Error('Mock Core is not running')
    signal.throwIfAborted()

    if (request.type === 'mock.health') {
      return { healthy: true, implementation: 'mock', checkedAt: Date.now() }
    }

    await abortableDelay(25, signal)
    const response = { message: request.payload.message, echoedAt: Date.now() }
    this.emit('mock.message', { sourceRequestId: requestId, ...response })
    return response
  }

  subscribe(listener: CoreEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(type: IpcEventEnvelope['type'], payload: unknown): void {
    const event: IpcEventEnvelope = {
      requestId: randomUUID(),
      type,
      payload,
      success: true,
      error: null,
      timestamp: Date.now()
    }
    for (const listener of this.listeners) listener(event)
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled'))
      },
      { once: true }
    )
  })
}
