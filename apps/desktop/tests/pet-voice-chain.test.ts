import { describe, expect, it } from 'vitest'
import { isCoreRequest } from '../src/shared/core'
import { shouldDisplayVoiceCacheStatus } from '../src/shared/pet-voice-cache-status'

describe('desktop pet voice protocol', () => {
  it('accepts complete Live2D click context without creating a realtime-TTS request', () => {
    expect(isCoreRequest({ type: 'pet.voice.play', payload: {
      triggerId: 'click', bodyPart: 'face', source: 'pet.live2d', hitAreaName: 'HitAreaFace', normalizedX: 0.4, normalizedY: 0.3
    } })).toBe(true)
    expect(isCoreRequest({ type: 'pet.voice.playback.report', payload: {
      triggerId: 'click', bodyPart: 'face', text: '你好', audioPath: 'C:\\cache\\voice.wav', played: true, reason: 'cache_match',
      generationId: 'generation', contextHash: 'hash', category: 'click', hitAreaName: 'HitAreaFace', normalizedX: 0.4, normalizedY: 0.3
    } })).toBe(true)
  })

  it('accepts startup playback only through the cached voice protocol', () => {
    expect(isCoreRequest({ type: 'pet.voice_cache.ensure', payload: { includeNextPeriod: true } })).toBe(true)
    expect(isCoreRequest({ type: 'pet.voice.play', payload: { triggerId: 'startup.welcome', bodyPart: 'default', source: 'pet.startup' } })).toBe(true)
  })

  it('shows foreground progress only for the current voice role', () => {
    expect(shouldDisplayVoiceCacheStatus({ isForeground: true, roleId: 'role-a' }, 'role-a')).toBe(true)
    expect(shouldDisplayVoiceCacheStatus({ isForeground: true, roleId: 'role-b' }, 'role-a')).toBe(false)
    expect(shouldDisplayVoiceCacheStatus({ isForeground: false, roleId: 'role-a' }, 'role-a')).toBe(false)
  })
})
