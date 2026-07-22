import { beforeEach, describe, expect, it, vi } from 'vitest'

const registeredCallbacks = new Map<string, () => void>()

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: vi.fn()
  },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      registeredCallbacks.set(accelerator, callback)
      return true
    },
    unregister: vi.fn()
  }
}))

import { SystemSettingsService } from '../src/main/services/system-settings-service'

describe('system settings direction hotkeys', () => {
  beforeEach(() => registeredCallbacks.clear())

  it('executes all Ctrl+arrow presentation actions and refreshes the pet renderer', async () => {
    let mode = 'image'
    const executeAction = vi.fn((action: string) => {
      if (action === 'cycle-mode') mode = 'png-sequence'
      return Promise.resolve()
    })
    const executeHotkey = vi.fn((action: string) => {
      if (action === 'cycle-mode-reverse') mode = 'image'
      return { mode }
    })
    const notifyPresentationChanged = vi.fn()
    const service = new SystemSettingsService(
      { get: () => ({}), open: vi.fn() } as never,
      { notifyPresentationChanged } as never,
      { currentMode: () => mode, executeAction, executeHotkey } as never,
      { invoke: vi.fn((_id: string, request: { type: string }) => Promise.resolve(request.type === 'settings.get' ? { settings: [] } : {})) } as never,
      { warn: vi.fn() } as never
    )

    await service.initialize()
    for (const accelerator of [
      'CommandOrControl+Right',
      'CommandOrControl+Left',
      'CommandOrControl+Down',
      'CommandOrControl+Up'
    ]) {
      registeredCallbacks.get(accelerator)?.()
      await vi.waitFor(() => expect(notifyPresentationChanged).toHaveBeenCalledTimes(
        ['CommandOrControl+Right', 'CommandOrControl+Left', 'CommandOrControl+Down', 'CommandOrControl+Up'].indexOf(accelerator) + 1
      ))
    }

    expect(executeAction).toHaveBeenNthCalledWith(1, 'cycle-mode', {})
    expect(executeAction).toHaveBeenNthCalledWith(2, 'next-image', {})
    expect(executeHotkey).toHaveBeenNthCalledWith(1, 'cycle-mode-reverse')
    expect(executeHotkey).toHaveBeenNthCalledWith(2, 'play-previous')
  })

  it('opens voice input at the pet item and uses the same hotkey to stop recording', async () => {
    const send = vi.fn()
    const captureWindow = { isVisible: () => true, webContents: { send } }
    const get = vi.fn(() => undefined as typeof captureWindow | undefined)
    const open = vi.fn(() => captureWindow)
    const positionWindowAtItem = vi.fn(() => Promise.resolve())
    const service = new SystemSettingsService(
      { get, open } as never,
      { positionWindowAtItem, notifyPresentationChanged: vi.fn() } as never,
      { currentMode: () => 'image', executeAction: vi.fn(), executeHotkey: vi.fn() } as never,
      { invoke: vi.fn((_id: string, request: { type: string }) => Promise.resolve(request.type === 'settings.get' ? { settings: [] } : {})) } as never,
      { warn: vi.fn() } as never
    )

    await service.initialize()
    registeredCallbacks.get('CommandOrControl+Shift+S')?.()
    await vi.waitFor(() => expect(positionWindowAtItem).toHaveBeenCalledWith(captureWindow))
    expect(open).toHaveBeenCalledWith('voice-input', 'pet', { trigger: 'global-hotkey' })

    get.mockReturnValue(captureWindow)
    registeredCallbacks.get('CommandOrControl+Shift+S')?.()
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('aimaid:voice-input', { type: 'stop' }))
  })
})
