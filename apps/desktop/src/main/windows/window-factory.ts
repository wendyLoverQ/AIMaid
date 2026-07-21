import { BrowserWindow } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WindowKind } from '../../shared/windows'
import type { Logger } from '../logging/logger'
import type { WindowDefinition } from './window-registry'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

export class WindowFactory {
  private readonly preloadPath = join(currentDirectory, '../preload/index.mjs')
  private readonly productionRendererPath = resolve(currentDirectory, '../renderer/index.html')

  constructor(private readonly log: Logger) {}

  create(definition: WindowDefinition): BrowserWindow {
    const window = new BrowserWindow({
      ...definition.options,
      title: `AIMaid - ${definition.id}`,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        spellcheck: false,
        additionalArguments: [`--aimaid-window=${definition.id}`]
      }
    })

    this.installNavigationGuards(window, definition.id)
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
