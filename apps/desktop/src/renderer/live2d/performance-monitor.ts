import type { PetPerformanceMetrics, PetRuntimeState } from '../../shared/pet'

export class PerformanceMonitor {
  private frameTimes: number[] = []
  private lastFrameAt = 0
  private frameId: number | undefined
  private reportTimer: number | undefined

  constructor(private readonly report: (metrics: PetPerformanceMetrics) => void) {}

  start(read: () => Omit<PetPerformanceMetrics, 'fps' | 'averageFrameMs' | 'p95FrameMs' | 'maximumFrameMs'>): void {
    if (this.frameId !== undefined) return
    this.lastFrameAt = performance.now()
    const sample = (now: number): void => {
      const elapsed = now - this.lastFrameAt
      this.lastFrameAt = now
      if (elapsed > 0 && elapsed < 1_000) {
        this.frameTimes.push(elapsed)
        if (this.frameTimes.length > 600) this.frameTimes.shift()
      }
      this.frameId = requestAnimationFrame(sample)
    }
    this.frameId = requestAnimationFrame(sample)
    this.reportTimer = window.setInterval(() => this.flush(read()), 5_000)
  }

  stop(): void {
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId)
    if (this.reportTimer !== undefined) window.clearInterval(this.reportTimer)
    this.frameId = undefined
    this.reportTimer = undefined
    this.lastFrameAt = 0
  }

  private flush(base: Omit<PetPerformanceMetrics, 'fps' | 'averageFrameMs' | 'p95FrameMs' | 'maximumFrameMs'>): void {
    const sorted = [...this.frameTimes].sort((a, b) => a - b)
    const average = sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
    this.report({
      ...base,
      fps: average > 0 ? 1_000 / average : 0,
      averageFrameMs: average,
      p95FrameMs: p95,
      maximumFrameMs: sorted.at(-1) ?? 0
    })
  }
}

export function isRenderingState(state: PetRuntimeState): boolean {
  return state === 'ready'
}
