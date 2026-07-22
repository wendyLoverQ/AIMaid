import { describe, expect, it } from 'vitest'
import { normalizeError, redact } from '../src/main/logging/logger'

describe('structured logger redaction', () => {
  it('redacts sensitive keys recursively without removing searchable correlation fields', () => {
    const value = redact({
      requestId: 'request-123',
      settings: {
        apiKey: 'secret-api-key',
        cookie: 'session=plaintext',
        nested: [{ access_token: 'secret-token', operation: 'resolve' }]
      }
    })

    expect(value).toEqual({
      requestId: 'request-123',
      settings: {
        apiKey: '[REDACTED]',
        cookie: '[REDACTED]',
        nested: [{ access_token: '[REDACTED]', operation: 'resolve' }]
      }
    })
  })

  it('redacts credentials embedded in authorization strings and URLs', () => {
    const value = redact({
      headerMessage: 'Bearer abc.def.ghi cookie=session-plain',
      endpoint: 'https://user:password@example.test/path?api_key=plain&mode=test'
    })

    expect(value).toEqual({
      headerMessage: 'Bearer [REDACTED] cookie=[REDACTED]',
      endpoint: 'https://[REDACTED]@example.test/path?api_key=[REDACTED]&mode=test'
    })
  })

  it('preserves Electron crash details supplied as a plain object', () => {
    expect(normalizeError({ reason: 'crashed', exitCode: -1073741819 })).toEqual({
      message: 'Non-Error failure details',
      reason: 'crashed',
      exitCode: -1073741819
    })
  })
})
