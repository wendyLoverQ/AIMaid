import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calculateTimerClock } from '../src/shared/timer-clock'

const desktopRoot = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(desktopRoot, path), 'utf8')

describe('workflow integrity', () => {
  it('uses the AIMaid brand icon for Windows packaging, app identity, windows, and tray', () => {
    const packageJson = JSON.parse(read('package.json')) as { build?: { win?: { icon?: string } } }
    const main = read('src/main/main.ts')
    const windowFactory = read('src/main/windows/window-factory.ts')
    expect(packageJson.build?.win?.icon).toBe('resources/ui/maid_assistant_icon.ico')
    expect(main).toContain("app.setAppUserModelId('com.aimaid.desktop')")
    expect(main).toContain("const applicationIconPath = join(uiResourceRoot, 'maid_assistant_icon.ico')")
    expect(windowFactory).toContain('icon: this.iconPath')
  })

  it('positions the tray menu before showing it and lets the window manager wait for rendering', () => {
    const trayController = read('src/main/services/tray-controller.ts')
    const position = trayController.indexOf('menu.setPosition(x, y, false)')
    const reopen = trayController.indexOf("if (existingMenu !== undefined) this.windows.open('tray-menu')")
    expect(trayController).toContain("const existingMenu = this.windows.get('tray-menu')")
    expect(position).toBeGreaterThan(-1)
    expect(reopen).toBeGreaterThan(position)
    expect(trayController).not.toContain('menu.show()')
    expect(trayController).not.toContain('menu.focus()')
  })

  it('derives timer progress from timestamps even when interval callbacks are delayed', () => {
    expect(calculateTimerClock('countup', 1_000, 4, 0, 6_900)).toEqual({ elapsedSeconds: 9, remainingSeconds: 0, completed: false })
    expect(calculateTimerClock('countdown', 1_000, 2, 10, 14_400)).toEqual({ elapsedSeconds: 12, remainingSeconds: 0, completed: true })
    expect(calculateTimerClock('countdown', null, 7, 3, 99_000)).toEqual({ elapsedSeconds: 7, remainingSeconds: 3, completed: false })
  })

  it('flushes notebook drafts before navigation and window close through one serial queue', () => {
    const notebook = read('src/renderer/pages/notebook/NotebookPage.tsx')
    expect(notebook).toContain('saveQueue.current.then')
    expect(notebook).toContain('const choose = async')
    expect(notebook).toContain('await flushDraft(); setSelectedId')
    expect(notebook).toContain('onClose={async () => { try { await flushDraft(); await bridge.window.close() }')
  })

  it('uses completion-driven status polling with visible recovery state', () => {
    const status = read('src/renderer/pages/status/StatusPage.tsx')
    expect(status).not.toContain('window.setInterval(() => void refreshResources(), 200)')
    expect(status).toContain('timer = window.setTimeout(() => void run(), intervalMs)')
    expect(status).toContain('部分状态刷新失败')
    expect(status).toContain('lastSuccessfulAt')
    expect(status).toContain('retryAll')
  })
})
