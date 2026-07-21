import type { BrowserWindow, WebContents } from 'electron'
import type { WindowKind } from '../../shared/windows'
import type { Logger } from '../logging/logger'
import type { WindowFactory } from './window-factory'
import { WINDOW_REGISTRY } from './window-registry'

export class WindowManager {
  private readonly windows = new Map<WindowKind, BrowserWindow>()
  private destroyingAll = false

  constructor(
    private readonly factory: WindowFactory,
    private readonly log: Logger
  ) {}

  open(kind: WindowKind): BrowserWindow {
    const existing = this.get(kind)
    if (existing !== undefined) {
      existing.show()
      existing.focus()
      return existing
    }

    const definition = WINDOW_REGISTRY[kind]
    const window = this.factory.create(definition)
    this.windows.set(kind, window)
    window.once('ready-to-show', () => window.show())
    window.on('close', (event) => {
      if (!this.destroyingAll && definition.closeBehavior === 'hide') {
        event.preventDefault()
        window.hide()
      }
    })
    window.on('closed', () => {
      this.windows.delete(kind)
      this.log.info('window', 'Window destroyed', { kind })
    })
    this.log.info('window', 'Window created', { kind })
    return window
  }

  show(kind: WindowKind): void {
    this.open(kind).show()
  }

  hide(kind: WindowKind): void {
    this.get(kind)?.hide()
  }

  close(kind: WindowKind): void {
    this.get(kind)?.close()
  }

  focus(kind: WindowKind): void {
    const window = this.get(kind)
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  get(kind: WindowKind): BrowserWindow | undefined {
    const window = this.windows.get(kind)
    return window !== undefined && !window.isDestroyed() ? window : undefined
  }

  kindFor(contents: WebContents): WindowKind | undefined {
    for (const [kind, window] of this.windows) {
      if (!window.isDestroyed() && window.webContents.id === contents.id) return kind
    }
    return undefined
  }

  isTrusted(contents: WebContents, frameUrl: string): boolean {
    const kind = this.kindFor(contents)
    return kind !== undefined && this.factory.isTrustedPage(frameUrl, kind)
  }

  forEach(callback: (kind: WindowKind, window: BrowserWindow) => void): void {
    for (const [kind, window] of this.windows) {
      if (!window.isDestroyed()) callback(kind, window)
    }
  }

  destroyAll(): void {
    this.destroyingAll = true
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy()
    }
    this.windows.clear()
  }
}
