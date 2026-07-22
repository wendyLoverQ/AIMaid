import { randomUUID } from 'node:crypto'
import { powerMonitor, screen } from 'electron'
import type { BrowserWindow, Rectangle, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc'
import { PET_BASE_WINDOW_HEIGHT, PET_BASE_WINDOW_WIDTH } from '../../shared/pet-geometry'
import type {
  PetLifecycleEvent,
  PetLifecycleSignal,
  PetPerformanceMetrics,
  PetRendererVisualBounds,
  PetRuntimeSnapshot,
  PetWindowUpdate
} from '../../shared/pet'
import type { Logger } from '../logging/logger'
import type { CoreClient } from '../core/core-client'
import type { WindowManager } from './window-manager'
import type { WindowActionContext } from './window-manager'
import { physicalPetItemBoundsToDip } from './window-positioning'

interface PhysicalWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export class PetWindowManager {
  private static readonly MIN_SCALE = 0.25
  private static readonly MAX_WINDOW_SIZE = 100_000
  private attachedWindowId: number | undefined
  private ready = false
  private ignoreMouseEvents: boolean | undefined
  private forwardMouseMoves = false
  private foreignWindowMoving = false
  private lastMetricsLogAt = 0
  private lastMetrics: PetPerformanceMetrics | null = null
  private lastMetricsAt: number | null = null
  private physicalWindowBounds: PhysicalWindowBounds | undefined
  private lastRendererVisualBounds: PetRendererVisualBounds | undefined
  private installed = false
  private dragState: {
    startCursorX: number
    startCursorY: number
    startX: number
    startY: number
    width: number
    height: number
  } | null = null

  constructor(
    private readonly windows: WindowManager,
    private readonly core: CoreClient,
    private readonly log: Logger
  ) {}

  install(): void {
    if (this.installed) return
    this.installed = true
    screen.on('display-added', this.handleDisplaysChanged)
    screen.on('display-removed', this.handleDisplaysChanged)
    screen.on('display-metrics-changed', this.handleDisplaysChanged)
    powerMonitor.on('suspend', this.handleSuspend)
    powerMonitor.on('lock-screen', this.handleSuspend)
    powerMonitor.on('resume', this.handleResume)
    powerMonitor.on('unlock-screen', this.handleResume)
  }

  dispose(): void {
    if (!this.installed) return
    screen.off('display-added', this.handleDisplaysChanged)
    screen.off('display-removed', this.handleDisplaysChanged)
    screen.off('display-metrics-changed', this.handleDisplaysChanged)
    powerMonitor.off('suspend', this.handleSuspend)
    powerMonitor.off('lock-screen', this.handleSuspend)
    powerMonitor.off('resume', this.handleResume)
    powerMonitor.off('unlock-screen', this.handleResume)
    this.installed = false
  }

  notifyPresentationChanged(): void {
    this.sendLifecycle('presentation-changed')
  }

  open(context: WindowActionContext = {}): BrowserWindow {
    const window = this.windows.open('pet', undefined, context)
    if (this.attachedWindowId !== window.id) this.attach(window)
    return window
  }

  rendererReady(contents: WebContents): void {
    const window = this.requireWindow(contents)
    this.setIgnoreMouseEvents(contents, true)
    this.ready = true
    void this.fitVirtualDesktop(window).then(() => {
      if (window.isDestroyed()) return
      window.showInactive()
      this.sendLifecycle('resume')
      this.log.info('pet-window', 'Pet renderer ready; virtual desktop window shown', { bounds: window.getBounds() })
    }).catch((error: unknown) => this.log.error('pet-window', 'Failed to fit virtual desktop window', error))
  }

  show(context: WindowActionContext = {}): void {
    const window = this.open(context)
    if (!this.ready) return
    window.showInactive()
    this.sendLifecycle('resume')
    this.log.info('pet-window', 'Pet window show requested', { windowId: window.id, ...context })
  }

  hide(context: WindowActionContext = {}): void {
    this.sendLifecycle('suspend')
    this.windows.hide('pet', context)
    this.ignoreMouseEvents = undefined
    this.forwardMouseMoves = false
    this.dragState = null
    this.log.info('pet-window', 'Pet window hide requested', { ...context })
  }

  resetPosition(): void {
    const window = this.open()
    void this.fitVirtualDesktop(window)
    if (this.ready) window.showInactive()
    this.sendLifecycle('reset-position')
    this.log.info('pet-window', 'Pet virtual desktop bounds reset', { bounds: window.getBounds() })
  }

  setIgnoreMouseEvents(contents: WebContents, ignore: boolean): void {
    const window = this.requireWindow(contents)

    if (this.foreignWindowMoving) {
      this.applyMouseMode(window, true, false)
      return
    }

    this.applyMouseMode(window, ignore, ignore)
  }

  suspendHitTestingForForeignWindowMove(): void {
    if (this.foreignWindowMoving) return

    this.foreignWindowMoving = true

    const window = this.windows.get('pet')
    if (window === undefined) return

    this.applyMouseMode(window, true, false)
  }

  resumeHitTestingAfterForeignWindowMove(): void {
    if (!this.foreignWindowMoving) return

    this.foreignWindowMoving = false

    const window = this.windows.get('pet')
    if (window === undefined) return

    this.applyMouseMode(window, true, true)
  }

  dragStart(contents: WebContents): void {
    const window = this.requireWindow(contents)
    const cursor = screen.getCursorScreenPoint()
    const bounds = window.getBounds()
    this.dragState = {
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startX: bounds.x,
      startY: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
  }

  dragMove(contents: WebContents): Rectangle {
    const window = this.requireWindow(contents)
    if (this.dragState === null) return window.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const bounds = {
      x: Math.round(this.dragState.startX + cursor.x - this.dragState.startCursorX),
      y: Math.round(this.dragState.startY + cursor.y - this.dragState.startCursorY),
      width: this.dragState.width,
      height: this.dragState.height
    }
    window.setBounds(bounds, false)
    return window.getBounds()
  }

  dragEnd(contents: WebContents): Rectangle {
    const window = this.requireWindow(contents)
    this.dragState = null
    return window.getBounds()
  }

  updateWindow(contents: WebContents, update: PetWindowUpdate): Rectangle {
    const window = this.requireWindow(contents)
    this.dragState = null
    const current = window.getBounds()
    const scale = update.scale === undefined ? current.width / PET_BASE_WINDOW_WIDTH : Math.max(PetWindowManager.MIN_SCALE, update.scale)
    const width = Math.min(PetWindowManager.MAX_WINDOW_SIZE, Math.max(1, Math.round(PET_BASE_WINDOW_WIDTH * scale)))
    const height = Math.min(PetWindowManager.MAX_WINDOW_SIZE, Math.max(1, Math.round(PET_BASE_WINDOW_HEIGHT * scale)))
    const x = update.x ?? (update.anchor === 'center' ? Math.round(current.x + (current.width - width) / 2) : current.x)
    const y = update.y ?? (update.anchor === 'center' ? Math.round(current.y + (current.height - height) / 2) : current.y)
    const bounds = { x: Math.round(x), y: Math.round(y), width, height }
    window.setBounds(bounds, false)
    return window.getBounds()
  }

  reportMetrics(contents: WebContents, metrics: PetPerformanceMetrics): void {
    this.requireWindow(contents)
    const now = Date.now()
    this.lastMetrics = metrics
    this.lastMetricsAt = now
    if (now - this.lastMetricsLogAt < 10_000) return
    this.lastMetricsLogAt = now
    this.log.info('pet-performance', 'Live2D metrics', { ...metrics })
  }

  reportVisualBounds(contents: WebContents, bounds: PetRendererVisualBounds): void {
    const window = this.requireWindow(contents)
    this.lastRendererVisualBounds = bounds
    this.updateAbsoluteVisualBounds(window, bounds)
  }

  runtimeStatus(): PetRuntimeSnapshot {
    return { rendererReady: this.ready, metrics: this.lastMetrics, updatedAt: this.lastMetricsAt }
  }

  private attach(window: BrowserWindow): void {
    this.attachedWindowId = window.id
    this.ready = false
    this.ignoreMouseEvents = undefined
    this.forwardMouseMoves = false
    window.setMaximumSize(PetWindowManager.MAX_WINDOW_SIZE, PetWindowManager.MAX_WINDOW_SIZE)
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.webContents.on('render-process-gone', () => {
      this.ready = false
      this.lastMetrics = null
      this.lastMetricsAt = null
      this.ignoreMouseEvents = undefined
      this.forwardMouseMoves = false
      if (!window.isDestroyed()) window.hide()
    })
    window.on('will-resize', (_event, newBounds) => {
      if (this.dragState === null) return
      newBounds.width = this.dragState.width
      newBounds.height = this.dragState.height
    })
    window.once('closed', () => {
      this.attachedWindowId = undefined
      this.ready = false
      this.lastMetrics = null
      this.lastMetricsAt = null
      this.ignoreMouseEvents = undefined
      this.forwardMouseMoves = false
      this.dragState = null
    })
  }

  private applyMouseMode(window: BrowserWindow, ignore: boolean, forward: boolean): void {
    const nextForward = ignore && forward

    if (
      this.ignoreMouseEvents === ignore &&
      this.forwardMouseMoves === nextForward
    ) {
      return
    }

    window.setIgnoreMouseEvents(
      ignore,
      nextForward ? { forward: true } : undefined
    )

    this.ignoreMouseEvents = ignore
    this.forwardMouseMoves = nextForward
  }

  private async fitVirtualDesktop(window: BrowserWindow): Promise<void> {
    const handle = window.getNativeWindowHandle()
    const windowHandle = (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString()
    const result = await this.core.invoke(randomUUID(), {
      type: 'system.window.fit_virtual_desktop',
      payload: { windowHandle }
    }, new AbortController().signal)
    const bounds = readPhysicalWindowBounds(result)
    this.physicalWindowBounds = bounds
    if (this.lastRendererVisualBounds !== undefined) this.updateAbsoluteVisualBounds(window, this.lastRendererVisualBounds)
    this.log.info('pet-window', 'Pet window fitted to Windows virtual desktop', { bounds, electronBounds: window.getBounds() })
  }

  private updateAbsoluteVisualBounds(window: BrowserWindow, rendererBounds: PetRendererVisualBounds): void {
    const physicalWindowBounds = this.physicalWindowBounds
    if (physicalWindowBounds === undefined) return
    const absoluteBounds = physicalPetItemBoundsToDip(
      physicalWindowBounds,
      rendererBounds,
      rendererBounds.scaleFactor,
      (point) => screen.screenToDipPoint(point),
      (point) => screen.getDisplayNearestPoint(point).scaleFactor
    )
    this.log.debug('window-positioning', 'Pet item physical bounds mapped', {
      physicalWindowBounds,
      rendererBounds,
      itemDipBounds: absoluteBounds
    })
    this.windows.updatePetVisualBounds(absoluteBounds)
  }

  private readonly handleDisplaysChanged = (): void => {
    const window = this.windows.get('pet')
    if (window !== undefined && !window.isDestroyed()) void this.fitVirtualDesktop(window)
    this.sendLifecycle('display-changed')
  }
  private readonly handleSuspend = (): void => this.sendLifecycle('suspend')
  private readonly handleResume = (): void => this.sendLifecycle('resume')

  private sendLifecycle(type: PetLifecycleSignal): void {
    const window = this.windows.get('pet')
    if (window === undefined || window.webContents.isDestroyed()) return
    const display = screen.getDisplayMatching(window.getBounds())
    const event: PetLifecycleEvent = { type, scaleFactor: display.scaleFactor, timestamp: Date.now() }
    window.webContents.send(IPC_CHANNELS.petLifecycle, event)
  }

  private requireWindow(contents: WebContents): BrowserWindow {
    if (this.windows.kindFor(contents) !== 'pet') throw new Error('Only PetWindow may perform this operation')
    const window = this.windows.get('pet')
    if (window === undefined) throw new Error('PetWindow is unavailable')
    return window
  }
}

function readPhysicalWindowBounds(value: unknown): PhysicalWindowBounds {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid physical pet window bounds')
  const record = value as Record<string, unknown>
  const x = record.x ?? record.X
  const y = record.y ?? record.Y
  const width = record.width ?? record.Width
  const height = record.height ?? record.Height
  if (![x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item)) ||
      (width as number) <= 0 || (height as number) <= 0) {
    throw new TypeError('Invalid physical pet window bounds')
  }
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}
