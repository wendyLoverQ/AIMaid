import type { PetLifecycleEvent, PetLipSyncFrame, PetPerformanceMetrics, PetRuntimeState } from '../../shared/pet'
import type { AlphaContour } from '../../shared/alpha-contour'
import { bridge } from '../shared/bridge'
import { PerformanceMonitor } from './performance-monitor'
import { Live2DPlayer } from './runtime/Live2DPlayer'

export interface PetRuntimeCallbacks {
  onState: (state: PetRuntimeState) => void
  onError: (message: string | null) => void
  onScale: (scale: number) => void
  onMetrics: (metrics: PetPerformanceMetrics) => void
}
export class PetRuntime {
  private readonly player: Live2DPlayer
  private readonly monitor: PerformanceMonitor
  private state: PetRuntimeState = 'uninitialized'
  private loadTimeMs = 0
  private resizeCount = 0
  private contextLost = false
  private disposed = false
  private cleanups: Array<() => void> = []
  private currentModelId: string | null = null
  private queuedModelId: string | null = null
  private modelLoad: Promise<void> | null = null
  private desiredScale = 1
  private resizeFrame: number | null = null

  constructor(private readonly canvas: HTMLCanvasElement, private readonly callbacks: PetRuntimeCallbacks) {
    this.player = new Live2DPlayer(canvas)
    this.monitor = new PerformanceMonitor((metrics) => {
      this.callbacks.onMetrics(metrics)
      void bridge.pet.reportMetrics(metrics).then((response) => {
        if (!response.success) console.error('[PetRuntime] metrics rejected', response.error)
      })
    })
  }

  async initialize(modelId: string): Promise<void> {
    if (this.state !== 'uninitialized') return
    this.setState('loading')
    this.installLifecycleListeners()
    const startedAt = performance.now()
    try {
      await this.switchModel(modelId)
      if (this.disposed) {
        this.player.dispose()
        return
      }
      this.loadTimeMs = performance.now() - startedAt
      this.callbacks.onScale(this.player.currentScale)
      this.setState('ready')
      this.monitor.start(() => this.readMetricsBase())
      await bridge.pet.ready()
    } catch (error) {
      if (this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      console.error('[PetRuntime] initialization failed', message)
      this.callbacks.onError(message)
      this.setState('failed')
      await bridge.pet.ready()
    }
  }

  async switchModel(modelId: string): Promise<void> {
    if (modelId === '' || this.disposed) return
    if (this.currentModelId === modelId && this.modelLoad === null) return
    this.queuedModelId = modelId
    if (this.modelLoad !== null) return this.modelLoad
    this.modelLoad = this.drainModelQueue()
    try {
      await this.modelLoad
    } finally {
      this.modelLoad = null
    }
  }

  suspend(): void {
    if (this.state !== 'ready') return
    this.player.suspend()
    this.monitor.stop()
    this.setState('suspended')
  }

  resume(): void {
    if (this.state !== 'suspended') return
    this.player.resume()
    this.monitor.start(() => this.readMetricsBase())
    this.setState('ready')
  }

  containsPoint(clientX: number, clientY: number): boolean {
    return this.state === 'ready' && this.player.containsClientPoint(clientX, clientY)
  }

  captureAlphaContour(): AlphaContour | null {
    return this.state === 'ready' ? this.player.captureAlphaContour() : null
  }
  setScale(scale: number): void {
    this.desiredScale = scale
    this.player.setUserScale(scale)
  }

  async handlePointerClick(clientX: number, clientY: number, ctrlKey: boolean, altKey: boolean): Promise<void> {
    if (this.state !== 'ready') return
    if (altKey) {
      this.player.resetOutfit()
      return
    }
    const bodyPart = this.player.resolveAutoHitArea(clientX, clientY) ?? 'other'
    if (ctrlKey) this.player.cycleOutfit(bodyPart)
    else await this.player.playClickMotion(bodyPart)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame)
    this.resizeFrame = null
    this.monitor.stop()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.player.dispose()
    this.setState('disposed')
  }

  private installLifecycleListeners(): void {
    this.listen(window, 'resize', this.onResize)
    this.listen(this.canvas, 'webglcontextlost', this.onContextLost)
    this.listen(this.canvas, 'webglcontextrestored', this.onContextRestored)
    this.listen(window, 'keydown', this.onKeyDown)
    this.listen(window, 'storage', this.onPetBubble)
    this.cleanups.push(bridge.pet.onLifecycle(this.onLifecycle))
    this.cleanups.push(bridge.pet.onLipSync(this.onLipSync))
    const resizeObserver = new ResizeObserver(() => this.onResize())
    resizeObserver.observe(this.canvas.parentElement ?? this.canvas)
    this.cleanups.push(() => resizeObserver.disconnect())
  }

  private async drainModelQueue(): Promise<void> {
    while (this.queuedModelId !== null && !this.disposed) {
      const modelId = this.queuedModelId
      this.queuedModelId = null
      if (modelId === this.currentModelId) continue
      const response = await bridge.pet.getAssetManifest(modelId)
      if (!response.success || response.payload === null) throw new Error(response.error?.message ?? '桌宠资源清单不可用。')
      await this.player.loadModel(response.payload.modelUrl, response.payload.cubismCoreUrl)
      if (this.disposed) return
      this.player.setUserScale(this.desiredScale)
      this.currentModelId = modelId
      this.callbacks.onError(null)
      this.callbacks.onScale(this.player.currentScale)
    }
  }

  private readonly onResize = (): void => {
    if (this.resizeFrame !== null) return
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null
      this.resizeCount += 1
      this.player.handleWindowResize()
    })
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault()
    this.contextLost = true
    this.player.suspend()
    this.monitor.stop()
    this.setState('context-lost')
  }

  private readonly onContextRestored = (): void => {
    this.contextLost = false
    this.player.resume()
    this.monitor.start(() => this.readMetricsBase())
    this.setState('ready')
  }

  private readonly onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || !this.player.hasModelHotkey(event)) return
    event.preventDefault()
    void this.player.handleModelHotkey(event).catch((error: unknown) => {
      console.error('[Hotkey] Live2D model shortcut failed', error)
    })
  }

  private readonly onPetBubble = (event: Event): void => {
    if (!(event instanceof StorageEvent) || event.key !== 'aimaid.pet-bubble' || event.newValue === null) return
    try {
      const payload = JSON.parse(event.newValue) as { actionTag?: unknown }
      if (typeof payload.actionTag !== 'string' || payload.actionTag.trim() === '') return
      void this.player.applyActionTag(payload.actionTag).catch((error: unknown) => {
        console.error('[ActionTag] generated response action failed', error)
      })
    } catch (error) {
      console.error('[ActionTag] invalid generated response payload', error)
    }
  }

  private readonly onLifecycle = (event: PetLifecycleEvent): void => {
    if (event.type === 'suspend') this.suspend()
    else if (event.type === 'resume') this.resume()
    else this.onResize()
  }

  private readonly onLipSync = (frame: PetLipSyncFrame): void => {
    this.player.setLipSyncFrame(frame)
  }

  private readMetricsBase(): Omit<PetPerformanceMetrics, 'fps' | 'averageFrameMs' | 'p95FrameMs' | 'maximumFrameMs'> {
    return {
      state: this.state,
      loadTimeMs: this.loadTimeMs,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      ...this.player.getRenderMetrics(),
      resizeCount: this.resizeCount,
      contextLost: this.contextLost
    }
  }

  private setState(state: PetRuntimeState): void {
    this.state = state
    this.callbacks.onState(state)
  }

  private listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void {
    target.addEventListener(type, listener, options)
    this.cleanups.push(() => target.removeEventListener(type, listener, options))
  }
}
