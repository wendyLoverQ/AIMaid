import { describe, expect, it } from 'vitest'
import { CoreProtocolViolation, parseCoreLine } from '../src/main/core/protocol/envelope'
import { CORE_DEFAULT_REQUEST_TIMEOUT_MS, CORE_LONG_REQUEST_TIMEOUT_MS, coreRequestTimeoutMs, isCoreRequest } from '../src/shared/core'

const base = { protocolVersion: '1.0', timestamp: new Date().toISOString() }

describe('Core protocol parser', () => {
  it('allows cold-start LLM and speech requests to use the long timeout', () => {
    expect(coreRequestTimeoutMs('chat.send')).toBe(CORE_LONG_REQUEST_TIMEOUT_MS)
    expect(coreRequestTimeoutMs('tts.speak')).toBe(CORE_LONG_REQUEST_TIMEOUT_MS)
    expect(coreRequestTimeoutMs('asr.transcribe')).toBe(CORE_LONG_REQUEST_TIMEOUT_MS)
    expect(coreRequestTimeoutMs('agent.decide')).toBe(CORE_LONG_REQUEST_TIMEOUT_MS)
    expect(coreRequestTimeoutMs('system.health')).toBe(CORE_DEFAULT_REQUEST_TIMEOUT_MS)
  })

  it('parses successful and error responses', () => {
    expect(parseCoreLine(JSON.stringify({ ...base, id: 'request-001', kind: 'response', type: 'system.health', success: true, payload: {}, error: null })).kind).toBe('response')
    const error = parseCoreLine(JSON.stringify({
      ...base, id: 'request-002', kind: 'response', type: 'settings.get', success: false, payload: null,
      error: { code: 'INVALID_ARGUMENT', message: 'bad', details: {} }
    }))
    expect(error).toMatchObject({ kind: 'response', success: false })
  })

  it('parses ordered events', () => {
    expect(parseCoreLine(JSON.stringify({
      ...base, id: 'event-0001', kind: 'event', type: 'system.stream.progress', correlationId: 'request-001', sequence: 1, payload: {}
    }))).toMatchObject({ kind: 'event', sequence: 1 })
  })

  it('validates the Win32 PET client rectangle mapping request', () => {
    expect(isCoreRequest({
      type: 'system.window.map_client_rect',
      payload: { windowHandle: '12345', x: -10.5, y: 20, width: 560, height: 980, viewportWidth: 4928, viewportHeight: 3072 }
    })).toBe(true)
    expect(isCoreRequest({
      type: 'system.window.map_client_rect',
      payload: { windowHandle: '12345', x: 0, y: 0, width: 0, height: 980, viewportWidth: 4928, viewportHeight: 3072 }
    })).toBe(false)
  })

  it.each([
    ['invalid JSON', '{'],
    ['missing fields', JSON.stringify({ protocolVersion: '1.0', kind: 'response' })],
    ['incompatible version', JSON.stringify({ ...base, protocolVersion: '2.0', id: 'request-001', kind: 'response', type: 'system.health', success: true, payload: {}, error: null })],
    ['unknown kind', JSON.stringify({ ...base, id: 'request-001', kind: 'request', type: 'system.health', payload: {} })]
  ])('rejects %s', (_name, line) => {
    expect(() => parseCoreLine(line)).toThrow(CoreProtocolViolation)
  })
})
