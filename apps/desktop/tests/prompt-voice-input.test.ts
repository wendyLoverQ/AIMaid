import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canRequest } from '../src/shared/capabilities'
import { HOTKEY_ACTIONS } from '../src/shared/system-settings'

describe('chat prompt voice input', () => {
  const prompt = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/chat/PromptPage.tsx'), 'utf8')

  it('records, transcribes, and submits from the existing chat prompt', () => {
    expect(prompt).toContain('navigator.mediaDevices.getUserMedia')
    expect(prompt).toContain("bridge.speech.importAudioData")
    expect(prompt).toContain("type: 'asr.transcribe'")
    expect(prompt).toContain('await submit(false, false, recognized)')
    expect(canRequest('chat', 'speech.audio.importData')).toBe(true)
  })

  it('does not register a separate voice-input shortcut', () => {
    expect(HOTKEY_ACTIONS.some((item) => String(item.defaultGesture) === 'Ctrl+Shift+S')).toBe(false)
  })
})
