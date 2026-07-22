import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { CoreHandshake, CoreStatus } from '../src/shared/core'
import type { Logger } from '../src/main/logging/logger'
import { CoreClientError, StdioCoreClient } from '../src/main/core/stdio-core-client'
import type { CoreClientTransport, CoreRemoteError } from '../src/main/core/stdio-core-client'

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

class FakeTransport extends EventEmitter implements CoreClientTransport {
  status: CoreStatus = { state: 'handshaking', implementation: 'real' }
  readonly written: Array<Record<string, unknown>> = []
  suppress = new Set<string>()

  markReady(handshake: CoreHandshake): void {
    this.status = { state: 'ready', implementation: 'real', coreVersion: handshake.coreVersion, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities }
  }
  expectExit(): void {}
  health(): boolean { return this.status.state === 'ready' }
  writeLine(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>
    this.written.push(request)
    if (this.suppress.has(String(request.type))) return
    const payload = request.type === 'system.handshake'
      ? { coreVersion: '1.2.3', protocolVersion: '1.0', capabilities: ['system.health'], platform: 'test', arch: 'x64', desktopVersion: '0.1.0' }
      : { ok: true }
    queueMicrotask(() => this.emit('line', JSON.stringify({
      protocolVersion: '1.0', id: request.id, kind: 'response', type: request.type,
      timestamp: new Date().toISOString(), success: true, payload, error: null
    })))
  }
}

function createClient(transport: FakeTransport): StdioCoreClient {
  return new StdioCoreClient(transport, '0.1.0', silentLogger, { handshake: 100, request: 40, cancel: 100, shutdown: 100 })
}

describe('StdioCoreClient', () => {
  it('handshakes and handles concurrent requests', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    await client.start()
    const [first, second] = await Promise.all([
      client.invoke('request-101', { type: 'system.health', payload: {} }, new AbortController().signal),
      client.invoke('request-102', { type: 'settings.get', payload: { keys: ['app.language'] } }, new AbortController().signal)
    ])
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(client.getStatus().state).toBe('ready')
  })

  it('times out and rejects an unknown pending response path', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    await client.start()
    transport.suppress.add('system.health')
    await expect(client.invoke('request-201', { type: 'system.health', payload: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    transport.emit('line', JSON.stringify({ ...response('unknown-201', 'system.health'), payload: {} }))
  })

  it('propagates cancellation to Core', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    await client.start()
    transport.suppress.add('system.health')
    const controller = new AbortController()
    const pending = client.invoke('request-301', { type: 'system.health', payload: {} }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(CoreClientError)
    await vi.waitFor(() => expect(transport.written.some((item) => item.type === 'system.cancel')).toBe(true))
  })

  it('rejects duplicate request ids while the first request is pending', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    await client.start()
    transport.suppress.add('system.health')
    const first = client.invoke('request-duplicate', { type: 'system.health', payload: {} }, new AbortController().signal)
    await expect(client.invoke('request-duplicate', { type: 'system.health', payload: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PROTOCOL_DUPLICATE_REQUEST' })
    await expect(first).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })

  it('rejects pending requests when Core exits unexpectedly', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    await client.start()
    transport.suppress.add('system.health')
    const pending = client.invoke('request-exit', { type: 'system.health', payload: {} }, new AbortController().signal)
    transport.emit('exit')
    await expect(pending).rejects.toMatchObject({ code: 'CORE_EXITED' })
    await expect(client.invoke('request-after-exit', { type: 'system.health', payload: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'CORE_NOT_READY' })
  })

  it('logs responses whose request id is unknown', async () => {
    const transport = new FakeTransport()
    const warn = vi.fn()
    const logger: Logger = { ...silentLogger, warn }
    const client = new StdioCoreClient(transport, '0.1.0', logger, { handshake: 100, request: 40, cancel: 100, shutdown: 100 })
    await client.start()
    transport.emit('line', JSON.stringify({ ...response('unknown-response', 'system.health'), payload: {} }))
    expect(warn).toHaveBeenCalledWith('core-protocol', 'unknown response id', expect.objectContaining({ requestId: 'unknown-response' }))
  })

  it('uses the long timeout for long-running Core requests', async () => {
    const transport = new FakeTransport()
    const client = new StdioCoreClient(transport, '0.1.0', silentLogger, {
      handshake: 100, request: 10, longRequest: 80, cancel: 100, shutdown: 100
    })
    await client.start()
    transport.suppress.add('chat.send')
    const pending = client.invoke('request-long', { type: 'chat.send', payload: { content: 'hello' } }, new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(transport.written.some((item) => item.type === 'system.cancel')).toBe(false)
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })

  it('logs Core failures with their error code and details', async () => {
    const transport = new FakeTransport()
    const error = vi.fn()
    const client = new StdioCoreClient(transport, '0.1.0', { ...silentLogger, error }, {
      handshake: 100, request: 40, cancel: 100, shutdown: 100
    })
    await client.start()
    transport.suppress.add('system.health')
    const pending = client.invoke('request-failed', { type: 'system.health', payload: {} }, new AbortController().signal)
    transport.emit('line', JSON.stringify({
      ...response('request-failed', 'system.health'),
      success: false,
      payload: null,
      error: { code: 'DB_BUSY', message: 'database is busy', details: { operation: 'health' } }
    }))
    await expect(pending).rejects.toMatchObject({ code: 'DB_BUSY', details: { operation: 'health' } } satisfies Partial<CoreRemoteError>)
    expect(error).toHaveBeenCalledWith(
      'core-client',
      'Core request failed',
      expect.objectContaining({ code: 'DB_BUSY' }),
      expect.objectContaining({ requestId: 'request-failed', type: 'system.health', success: false })
    )
  })

  it('accepts chat streaming events declared by the shared Core contract', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    const listener = vi.fn()
    await client.start()
    client.subscribe(listener)
    transport.emit('line', JSON.stringify({ ...event('chat-event', 0), type: 'chat.delta', correlationId: 'conversation-1' }))
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.delta' }))
  })

  it('orders events and honors unsubscribe', async () => {
    const transport = new FakeTransport()
    const client = createClient(transport)
    const listener = vi.fn()
    await client.start()
    const unsubscribe = client.subscribe(listener)
    transport.emit('line', JSON.stringify(event('event-001', 1)))
    transport.emit('line', JSON.stringify(event('event-002', 1)))
    transport.emit('line', JSON.stringify(event('event-003', 2)))
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    transport.emit('line', JSON.stringify(event('event-004', 3)))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

function response(id: string, type: string): Record<string, unknown> {
  return { protocolVersion: '1.0', id, kind: 'response', type, timestamp: new Date().toISOString(), success: true, error: null }
}

function event(id: string, sequence: number): Record<string, unknown> {
  return { protocolVersion: '1.0', id, kind: 'event', type: 'system.stream.progress', timestamp: new Date().toISOString(), correlationId: 'request-stream', sequence, payload: {} }
}
