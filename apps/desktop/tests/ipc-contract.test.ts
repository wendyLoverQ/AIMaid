import { describe, expect, it } from 'vitest'
import { isIpcRequestEnvelope } from '../src/shared/ipc'

describe('IPC request envelope', () => {
  it('accepts a registered and well-formed request', () => {
    expect(
      isIpcRequestEnvelope({
        requestId: '12345678-test',
        type: 'core.status',
        payload: {},
        timestamp: Date.now()
      })
    ).toBe(true)
  })

  it('rejects unknown message types', () => {
    expect(
      isIpcRequestEnvelope({
        requestId: '12345678-test',
        type: 'shell.execute',
        payload: { command: 'anything' },
        timestamp: Date.now()
      })
    ).toBe(false)
  })

  it('rejects short request identifiers', () => {
    expect(isIpcRequestEnvelope({ requestId: '1', type: 'core.status', payload: {}, timestamp: Date.now() })).toBe(false)
  })
})
