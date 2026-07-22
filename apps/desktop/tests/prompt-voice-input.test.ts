import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canRequest } from '../src/shared/capabilities'
import { HOTKEY_ACTIONS } from '../src/shared/system-settings'

describe('chat prompt voice input', () => {
  const prompt = readFileSync(resolve(import.meta.dirname, '../src/renderer/pages/chat/PromptPage.tsx'), 'utf8')
  const promptStyles = readFileSync(resolve(import.meta.dirname, '../src/renderer/components/layout/Semantics.css'), 'utf8')

  it('records and puts the transcription into the existing chat prompt without sending', () => {
    expect(prompt).toContain('navigator.mediaDevices.getUserMedia')
    expect(prompt).toContain("bridge.speech.importAudioData")
    expect(prompt).toContain("type: 'asr.transcribe'")
    expect(prompt).toContain('setText(recognized)')
    expect(prompt).toContain("publishPetBubble('语音已转成文字，请确认后发送。', 'feedback')")
    expect(prompt).not.toContain('await submit(false, false, recognized)')
    expect(prompt).toContain('async function transcribe(audio: Blob)')
    expect(prompt).toContain('void transcribe(audio)')
    expect(prompt).toContain('variant="promptVoice"')
    expect(promptStyles).toContain('margin-inline-end: var(--space-1)')
    expect(prompt).not.toMatch(/type: 'asr\.transcribe'[\s\S]*?characterId[\s\S]*?\}, 120000/)
    expect(canRequest('chat', 'speech.audio.importData')).toBe(true)
  })

  it('silently resolves an available role only when the transcribed text is sent', () => {
    expect(prompt).toContain('const character = await currentCharacter()')
    expect(prompt).toContain('characters.items.find((item) => item.isEnabled)')
    expect(prompt).toContain('{ characterId: character.roleId }')
  })

  it('does not register a separate voice-input shortcut', () => {
    expect(HOTKEY_ACTIONS.some((item) => String(item.defaultGesture) === 'Ctrl+Shift+S')).toBe(false)
  })
})
