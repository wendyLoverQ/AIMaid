import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCoreRequest } from '../src/shared/core'

describe('desktop pet voice chain', () => {
  it('accepts the cache generation, lookup, and playback report protocol', () => {
    expect(isCoreRequest({ type: 'pet.voice_cache.ensure', payload: { includeNextPeriod: true } })).toBe(true)
    expect(isCoreRequest({ type: 'pet.voice.play', payload: { triggerId: 'click', bodyPart: 'head', source: 'pet.live2d' } })).toBe(true)
    expect(isCoreRequest({
      type: 'pet.voice.playback.report',
      payload: { triggerId: 'click.head', bodyPart: 'head', text: '你好', audioPath: 'C:\\cache\\voice.wav', played: true, reason: 'cache_match' }
    })).toBe(true)
  })

  it('routes image, PNG, and Live2D clicks through the same cached voice consumer', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/pet/PetPage.tsx'), 'utf8')
    expect(page).toContain("presentationRef.current?.mode === 'live2d'")
    expect(page).toContain('playPetClickVoice(resolveImageBodyPart')
    expect(page).toContain('playVoice(bodyPart)')
    expect(page).toContain("type: 'pet.voice.play'")
    expect(page).toContain("type: 'pet.voice.playback.report'")
  })

  it('does not let cached click audio preempt active realtime audio', () => {
    const playback = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/chat/tts-playback.ts'), 'utf8')
    expect(playback).toContain('export async function playCachedAudio')
    expect(playback).toContain('if (activeAudio !== null) return false')
  })

  it('regenerates after clearing instead of leaving the current cache empty', () => {
    const service = readFileSync(resolve(import.meta.dirname, '../../../src/AIMaid.Core/PetVoiceMenuApplicationService.cs'), 'utf8')
    const clearStart = service.indexOf('ClearCurrentCacheAsync')
    const clearEnd = service.indexOf('ResolvePlaybackAsync', clearStart)
    const clearFlow = service.slice(clearStart, clearEnd)
    expect(clearFlow).toContain('DeleteCacheEntriesAsync')
    expect(clearFlow).toContain('EnsureAsync')
    expect(service).toContain('GenerateNextPeriodAsync')
    expect(service).toContain('SourceKey: "lazy_voice_lines"')
    expect(service).toContain('TemplateCardJson')
  })
})
