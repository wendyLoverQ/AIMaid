import type { PetLifecycleEvent, PetPerformanceMetrics, PetRuntimeState, PetVisualBounds } from '../../shared/pet'
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

  getVisualBounds(): PetVisualBounds | null {
    const geometry = this.player.getModelGeometry()
    if (geometry === null) return null
    const canvasBounds = this.canvas.getBoundingClientRect()
    const metrics = this.player.getRenderMetrics()
    if (canvasBounds.width <= 0 || canvasBounds.height <= 0 || metrics.backingWidth <= 0 || metrics.backingHeight <= 0) return null
    // Pixi model geometry is reported in backing-pixel coordinates. Convert it
    // to renderer CSS DIPs before the main process adds the fullscreen window origin.
    const scaleX = canvasBounds.width / metrics.backingWidth
    const scaleY = canvasBounds.height / metrics.backingHeight
    return {
      x: Math.round(canvasBounds.x + geometry.modelBounds.x * scaleX),
      y: Math.round(canvasBounds.y + geometry.modelBounds.y * scaleY),
      width: Math.round(geometry.modelBounds.width * scaleX),
      height: Math.round(geometry.modelBounds.height * scaleY),
      anchorX: Math.round(canvasBounds.x + geometry.anchors.bodyCenter.x * scaleX),
      anchorY: Math.round(canvasBounds.y + geometry.anchors.bodyCenter.y * scaleY)
    }
  }

  setScale(scale: number): void {
    this.desiredScale = scale
    this.player.setUserScale(scale)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.monitor.stop()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.player.dispose()
    this.setState('disposed')
  }

  private installLifecycleListeners(): void {
    this.listen(window, 'resize', this.onResize)
    this.listen(this.canvas, 'webglcontextlost', this.onContextLost)
    this.listen(this.canvas, 'webglcontextrestored', this.onContextRestored)
    this.cleanups.push(bridge.pet.onLifecycle(this.onLifecycle))
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
    this.resizeCount += 1
    requestAnimationFrame(() => {
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

  private readonly onLifecycle = (event: PetLifecycleEvent): void => {
    if (event.type === 'suspend') this.suspend()
    else if (event.type === 'resume') this.resume()
    else this.onResize()
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
