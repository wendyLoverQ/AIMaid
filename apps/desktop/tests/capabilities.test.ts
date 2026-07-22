import { describe, expect, it } from 'vitest'
import { canRequest, WINDOW_CAPABILITIES } from '../src/shared/capabilities'
import { WINDOW_KINDS } from '../src/shared/windows'
import { WINDOW_REGISTRY } from '../src/main/windows/window-registry'

describe('window registry and capabilities', () => {
  it('defines every known window exactly once', () => {
    expect(Object.keys(WINDOW_REGISTRY).sort()).toEqual([...WINDOW_KINDS].sort())
    expect(new Set(Object.values(WINDOW_REGISTRY).map((definition) => definition.id)).size).toBe(WINDOW_KINDS.length)
  })

  it('opens the timer large enough to show the complete timer and records workspaces', () => {
    expect(WINDOW_REGISTRY.timer.options).toMatchObject({
      width: 560,
      height: 680,
      minWidth: 520,
      minHeight: 620
    })
  })

  it('limits PetWindow to its required Core and presentation APIs', () => {
    expect(canRequest('pet', 'dialog.openFile')).toBe(false)
    expect(canRequest('pet', 'core.invoke')).toBe(true)
    expect(canRequest('pet', 'window.open')).toBe(true)
    expect(canRequest('pet', 'window.quit')).toBe(true)
    expect(WINDOW_CAPABILITIES.pet.events).toBe(true)
  })

  it('grants SettingsWindow its real Core and platform settings module only', () => {
    expect(WINDOW_CAPABILITIES.settings.events).toBe(false)
    expect(canRequest('settings', 'core.invoke')).toBe(true)
    expect(canRequest('settings', 'dialog.openFile')).toBe(false)
    expect(canRequest('settings', 'system.settings.setHotkey')).toBe(true)
  })

  it('grants title-bar controls only to framed UI windows', () => {
    expect(canRequest('main', 'window.minimize')).toBe(true)
    expect(canRequest('chat', 'window.toggleMaximize')).toBe(true)
    expect(canRequest('settings', 'window.minimize')).toBe(true)
    expect(canRequest('pet', 'window.toggleMaximize')).toBe(false)
  })
})
