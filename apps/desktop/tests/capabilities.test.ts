import { describe, expect, it } from 'vitest'
import { canRequest, WINDOW_CAPABILITIES } from '../src/shared/capabilities'
import { WINDOW_KINDS } from '../src/shared/windows'
import { WINDOW_REGISTRY } from '../src/main/windows/window-registry'

describe('window registry and capabilities', () => {
  it('defines every known window exactly once', () => {
    expect(Object.keys(WINDOW_REGISTRY).sort()).toEqual([...WINDOW_KINDS].sort())
    expect(new Set(Object.values(WINDOW_REGISTRY).map((definition) => definition.id)).size).toBe(WINDOW_KINDS.length)
  })

  it('does not expose high privilege APIs to PetWindow', () => {
    expect(canRequest('pet', 'dialog.openFile')).toBe(false)
    expect(canRequest('pet', 'core.invoke')).toBe(false)
    expect(canRequest('pet', 'window.open')).toBe(false)
    expect(WINDOW_CAPABILITIES.pet.events).toBe(true)
  })

  it('does not subscribe SettingsWindow to Core events', () => {
    expect(WINDOW_CAPABILITIES.settings.events).toBe(false)
  })
})
