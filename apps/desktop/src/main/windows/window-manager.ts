import { screen } from 'electron'
import type { BrowserWindow, Rectangle, WebContents } from 'electron'
import type { WindowKind } from '../../shared/windows'
import type { Logger } from '../logging/logger'
import type { WindowFactory } from './window-factory'
import { WINDOW_REGISTRY } from './window-registry'

export interface WindowActionContext {
  requestId?: string
  sourceWindow?: WindowKind
  trigger?: string
}

interface ForeignWindowMoveHandlers {
  onStart: () => void
  onEnd: () => void
}

export class WindowManager {
  private readonly windows = new Map<WindowKind, BrowserWindow>()
  private destroyingAll = false
  private foreignWindowMoveHandlers: ForeignWindowMoveHandlers | undefined
  private trayIconPointerDown = false

  constructor(
    private readonly factory: WindowFactory,
    private readonly log: Logger
  ) {}

  setForeignWindowMoveHandlers(handlers: ForeignWindowMoveHandlers): void {
    this.foreignWindowMoveHandlers = handlers
  }

  setTrayIconPointerDown(pointerDown: boolean): void {
    this.trayIconPointerDown = pointerDown
  }

  open(kind: WindowKind, ownerKind?: WindowKind, context: WindowActionContext = {}): BrowserWindow {
    const existing = this.get(kind)
    if (existing !== undefined) {
      this.positionWindow(kind, existing, ownerKind)
      if (kind === 'tray-menu') {
        this.log.info('window', 'Existing window opened', { kind, windowId: existing.id, ...context })
        return existing
      }
      if (kind === 'pet') existing.showInactive()
      else {
        if (kind === 'chat') existing.setAlwaysOnTop(true, 'screen-saver')
        existing.show()
        existing.focus()
        if (kind === 'chat') existing.moveTop()
      }
      this.log.info('window', 'Existing window opened', { kind, windowId: existing.id, ...context })
      return existing
    }

    const definition = WINDOW_REGISTRY[kind]
    const window = this.factory.create(definition)

    if (kind === 'chat') window.setAlwaysOnTop(true, 'screen-saver')

    if (kind !== 'pet' && kind !== 'tray-menu') {
      this.attachForeignWindowMoveGuard(window)
    }

    this.positionWindow(kind, window, ownerKind)
    this.windows.set(kind, window)
    if (kind !== 'pet') {
      let shown = false
      const showLoadedWindow = (): void => {
        if (shown || window.isDestroyed()) return
        shown = true
        window.show()
        window.focus()
        if (kind === 'chat') window.moveTop()
      }
      window.once('ready-to-show', showLoadedWindow)
    }
    if (kind === 'chat') window.on('blur', () => window.hide())
    if (kind === 'tray-menu') window.on('blur', () => {
      if (!this.trayIconPointerDown) window.hide()
    })
    window.on('close', (event) => {
      if (!this.destroyingAll && definition.closeBehavior === 'hide') {
        event.preventDefault()
        window.hide()
      }
    })
    window.on('closed', () => {
      this.windows.delete(kind)
      this.log.info('window', 'Window destroyed', { kind, windowId: window.id })
    })
    window.on('show', () => this.log.info('window', 'Window shown', { kind, windowId: window.id }))
    window.on('hide', () => this.log.info('window', 'Window hidden', { kind, windowId: window.id }))
    window.on('focus', () => this.log.debug('window', 'Window focused', { kind, windowId: window.id }))
    window.on('blur', () => this.log.debug('window', 'Window blurred', { kind, windowId: window.id }))
    window.on('minimize', () => this.log.info('window', 'Window minimized', { kind, windowId: window.id }))
    window.on('restore', () => this.log.info('window', 'Window restored', { kind, windowId: window.id }))
    this.log.info('window', 'Window created', { kind, windowId: window.id, webContentsId: window.webContents.id, ...context })
    return window
  }

  async openAndWait(kind: WindowKind, ownerKind?: WindowKind, context: WindowActionContext = {}): Promise<BrowserWindow> {
    const window = this.open(kind, ownerKind, context)
    if (kind === 'pet' || kind === 'tray-menu') return window

    if (!window.isVisible()) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          window.off('ready-to-show', ready)
          window.webContents.off('did-fail-load', failed)
          window.off('closed', closed)
        }
        const ready = (): void => { cleanup(); resolve() }
        const failed = (_event: Electron.Event, errorCode: number, errorDescription: string): void => {
          cleanup()
          reject(new Error(`Window ${kind} failed to load (${errorCode}): ${errorDescription}`))
        }
        const closed = (): void => { cleanup(); reject(new Error(`Window ${kind} closed before it was shown`)) }
        window.once('ready-to-show', ready)
        window.webContents.once('did-fail-load', failed)
        window.once('closed', closed)
      })
      if (window.isDestroyed()) throw new Error(`Window ${kind} was destroyed before it was shown`)
      window.show()
    }

    if (window.isMinimized()) window.restore()
    window.focus()
    this.log.info('window', 'Window open completed', { kind, windowId: window.id, ...context })
    return window
  }

  show(kind: WindowKind, context: WindowActionContext = {}): void {
    const window = this.open(kind, undefined, context)
    window.show()
    this.log.info('window', 'Window show requested', { kind, windowId: window.id, ...context })
  }

  hide(kind: WindowKind, context: WindowActionContext = {}): void {
    const window = this.get(kind)
    window?.hide()
    this.log.info('window', 'Window hide requested', { kind, windowId: window?.id ?? null, found: window !== undefined, ...context })
  }

  toggle(kind: WindowKind, ownerKind?: WindowKind, context: WindowActionContext = {}): boolean {
    const existing = this.get(kind)
    if (existing !== undefined && existing.isVisible()) {
      existing.hide()
      this.log.info('window', 'Window toggled hidden', { kind, windowId: existing.id, ...context })
      return false
    }
    const window = this.open(kind, ownerKind, context)
    this.log.info('window', 'Window toggled visible', { kind, windowId: window.id, ...context })
    return true
  }

  close(kind: WindowKind, context: WindowActionContext = {}): void {
    const window = this.get(kind)
    window?.close()
    this.log.info('window', 'Window close requested', { kind, windowId: window?.id ?? null, found: window !== undefined, ...context })
  }

  focus(kind: WindowKind, context: WindowActionContext = {}): void {
    const window = this.get(kind)
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    this.log.info('window', 'Window focus requested', { kind, windowId: window.id, ...context })
  }

  minimize(kind: WindowKind, context: WindowActionContext = {}): void {
    const window = this.get(kind)
    window?.minimize()
    this.log.info('window', 'Window minimize requested', { kind, windowId: window?.id ?? null, found: window !== undefined, ...context })
  }

  toggleMaximize(kind: WindowKind, context: WindowActionContext = {}): boolean {
    const window = this.get(kind)
    if (window === undefined) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    this.log.info('window', 'Window maximize toggled', { kind, windowId: window.id, maximized: window.isMaximized(), ...context })
    return window.isMaximized()
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

  private attachForeignWindowMoveGuard(window: BrowserWindow): void {
    let moving = false

    const begin = (): void => {
      if (moving) return
      moving = true
      this.foreignWindowMoveHandlers?.onStart()
    }

    const end = (): void => {
      if (!moving) return
      moving = false
      this.foreignWindowMoveHandlers?.onEnd()
    }

    window.on('will-move', begin)
    window.on('moved', end)
    window.once('closed', end)
  }

  private positionWindow(kind: WindowKind, window: BrowserWindow, ownerKind?: WindowKind): void {
    if (kind === 'pet' || kind === 'tray-menu') return
    const owner = ownerKind === undefined ? undefined : this.get(ownerKind)
    if (ownerKind === 'pet' && owner !== undefined) return
    const ownerCentered = owner !== undefined && OWNER_CENTERED_WINDOWS.has(kind)
    const target = ownerCentered ? owner.getBounds() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const workArea = ownerCentered ? screen.getDisplayMatching(target).workArea : target
    const current = window.getBounds()
    const width = Math.min(current.width, workArea.width)
    const height = Math.min(current.height, workArea.height)
    const centered = centerWithin(target, width, height)
    window.setBounds({
      x: Math.max(workArea.x, Math.min(centered.x, workArea.x + workArea.width - width)),
      y: Math.max(workArea.y, Math.min(centered.y, workArea.y + workArea.height - height)),
      width,
      height
    }, false)
  }

}

const OWNER_CENTERED_WINDOWS = new Set<WindowKind>([
  'characters', 'character-editor', 'template-card', 'notebook',
  'crypto-events', 'crypto-provider', 'crypto-chart',
  'video-player', 'video-subtitles', 'remote-site-config', 'douyin-login'
])

function centerWithin(target: Rectangle, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.round(target.x + (target.width - width) / 2),
    y: Math.round(target.y + (target.height - height) / 2)
  }
}
