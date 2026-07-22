import { app, BrowserWindow } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WindowKind } from '../../shared/windows'
import type { Logger } from '../logging/logger'
import type { WindowDefinition } from './window-registry'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

export class WindowFactory {
  private readonly preloadPath = join(currentDirectory, '../preload/index.cjs')
  private readonly productionRendererPath = resolve(currentDirectory, '../renderer/index.html')

  constructor(
    private readonly iconPath: string,
    private readonly log: Logger
  ) {}

  create(definition: WindowDefinition): BrowserWindow {
    const window = new BrowserWindow({
      ...definition.options,
      title: `AIMaid - ${definition.id}`,
      icon: this.iconPath,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: definition.id === 'douyin-login',
        spellcheck: false,
        backgroundThrottling: definition.id !== 'pet',
        additionalArguments: [`--aimaid-window=${definition.id}`, `--aimaid-version=${app.getVersion()}`]
      }
    })

    this.installNavigationGuards(window, definition.id)
    if (definition.id === 'pet' || definition.id === 'music-visualizer') {
      window.webContents.on('console-message', (details) => {
        if (details.level === 'warning' || details.level === 'error' || /^\[(Live2D|PetRuntime|PetInteraction|Hotkey|Motion|Pointer|Outfit|MusicPlayback)\]/u.test(details.message)) {
          this.log.info(definition.id === 'pet' ? 'pet-renderer' : 'music-renderer', details.message.slice(0, 2_000), { level: details.level })
        }
      })
    }
    window.webContents.on('render-process-gone', (_event, details) => {
      this.log.error('window', 'Renderer process gone', new Error(`Renderer exited: ${details.reason}`), {
        kind: definition.id,
        windowId: window.id,
        webContentsId: window.webContents.id,
        reason: details.reason,
        exitCode: details.exitCode
      })
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.log.error('window', 'Renderer failed to load', new Error(errorDescription), {
        kind: definition.id,
        windowId: window.id,
        webContentsId: window.webContents.id,
        errorCode,
        validatedURL,
        isMainFrame
      })
    })
    window.webContents.on('unresponsive', () => this.log.warn('window', 'Renderer became unresponsive', {
      kind: definition.id,
      windowId: window.id,
      webContentsId: window.webContents.id
    }))
    window.webContents.on('responsive', () => this.log.info('window', 'Renderer recovered responsiveness', {
      kind: definition.id,
      windowId: window.id,
      webContentsId: window.webContents.id
    }))
    void this.load(window, definition.route)
    return window
  }

  isTrustedPage(url: string, kind: WindowKind): boolean {
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl !== undefined) {
      try {
        const expected = new URL(developmentUrl)
        const actual = new URL(url)
        return actual.origin === expected.origin && actual.searchParams.get('window') === kind
      } catch {
        return false
      }
    }

    try {
      const actual = new URL(url)
      return actual.protocol === 'file:' && fileURLToPath(actual).toLowerCase() === this.productionRendererPath.toLowerCase()
    } catch {
      return false
    }
  }

  private async load(window: BrowserWindow, route: WindowKind): Promise<void> {
    try {
      const developmentUrl = process.env.ELECTRON_RENDERER_URL
      if (developmentUrl !== undefined) {
        const url = new URL(developmentUrl)
        url.searchParams.set('window', route)
        await window.loadURL(url.toString())
      } else {
        await window.loadFile(this.productionRendererPath, { query: { window: route } })
      }
    } catch (error) {
      this.log.error('window', `Failed to load ${route}`, error)
    }
  }

  private installNavigationGuards(window: BrowserWindow, kind: WindowKind): void {
    window.webContents.on('will-navigate', (event, url) => {
      if (!this.isTrustedPage(url, kind)) {
        event.preventDefault()
        this.log.warn('security', 'Blocked window navigation', { kind, url })
      }
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.log.warn('security', 'Blocked new window request', { kind, url })
      return { action: 'deny' }
    })
  }
}
