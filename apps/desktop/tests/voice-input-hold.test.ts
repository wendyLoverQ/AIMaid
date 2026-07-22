import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('push-to-talk voice input', () => {
  it('waits for the physical shortcut release through Win32', () => {
    const keyboard = readFileSync(new URL('../../../src/AIMaid.Platform.Windows/WindowsKeyboardState.cs', import.meta.url), 'utf8')
    const page = readFileSync(new URL('../src/renderer/pages/chat/VoiceInputPage.tsx', import.meta.url), 'utf8')
    expect(keyboard).toContain('GetAsyncKeyState')
    expect(keyboard).toContain('virtualKeys.All(IsPressed)')
    expect(page).toContain("type: 'system.keyboard.wait_release'")
    expect(page).toContain('if (!disposedRef.current) stopRecording()')
  })

  it('keeps the compact indicator above other windows without taking focus', () => {
    const manager = readFileSync(new URL('../src/main/windows/window-manager.ts', import.meta.url), 'utf8')
    expect(manager).toContain("kind === 'chat' || kind === 'voice-input'")
    expect(manager).toContain("kind === 'voice-input') window.showInactive()")
    expect(manager).toContain("setAlwaysOnTop(true, 'screen-saver')")
  })
})
