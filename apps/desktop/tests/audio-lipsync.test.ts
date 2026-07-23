import { describe, expect, it } from 'vitest'
import { computeLipSyncLevel } from '../src/shared/audio-lipsync'

describe('audio-driven Live2D lip sync', () => {
  it('keeps the mouth closed for silent audio', () => {
    expect(computeLipSyncLevel(new Float32Array(256))).toBe(0)
  })

  it('keeps audible speech visible and clamps loud audio', () => {
    expect(computeLipSyncLevel(new Float32Array(256).fill(0.02))).toBe(0.4)
    expect(computeLipSyncLevel(new Float32Array(256).fill(0.2))).toBe(1)
  })
})
