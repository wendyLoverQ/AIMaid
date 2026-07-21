import { describe, expect, it, vi } from 'vitest'
import { MockCoreClient } from '../src/main/core/mock-core-client'

describe('MockCoreClient', () => {
  it('handles invoke and publishes an event through the replaceable client boundary', async () => {
    const client = new MockCoreClient()
    const listener = vi.fn()
    const unsubscribe = client.subscribe(listener)
    await client.start()

    const result = await client.invoke(
      'request-123',
      { type: 'mock.echo', payload: { message: 'hello' } },
      new AbortController().signal
    )

    expect(result).toMatchObject({ message: 'hello' })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'mock.message' }))
    unsubscribe()
    await client.stop()
  })

  it('honors cancellation', async () => {
    const client = new MockCoreClient()
    await client.start()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(
      client.invoke('request-456', { type: 'mock.echo', payload: { message: 'hello' } }, controller.signal)
    ).rejects.toThrow('cancelled')
  })
})
