import type { IpcResponseEnvelope } from './ipc'

export const VIDEO_PROGRESS_INTERVAL_MS = 7_000
export const VIDEO_PROGRESS_RETRY_MS = 2_500

type ProgressSnapshot = { positionSeconds: number; durationSeconds: number }
type PersistProgress = (snapshot: ProgressSnapshot) => Promise<IpcResponseEnvelope>
type StatusListener = (message: string) => void

export function restoredPlaybackPosition(lastPositionSeconds: number, durationSeconds: number, isCompleted: boolean): number {
  const position = normalizeSeconds(lastPositionSeconds)
  const duration = normalizeSeconds(durationSeconds)
  if (position === 0 || duration === 0) return 0
  if (isCompleted || duration - position <= Math.min(20, duration * 0.05)) return 0
  return Math.min(position, duration)
}

export class VideoProgressSession {
  private latest: ProgressSnapshot | null = null
  private lastAttemptAt = Number.NEGATIVE_INFINITY
  private inFlight = false
  private flushAfterFlight = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly persist: PersistProgress,
    private readonly onStatus: StatusListener,
    private readonly now: () => number = Date.now
  ) {}

  update(positionSeconds: number, durationSeconds: number): void {
    if (this.disposed) return
    this.latest = normalizedSnapshot(positionSeconds, durationSeconds)
    if (this.now() - this.lastAttemptAt >= VIDEO_PROGRESS_INTERVAL_MS) void this.persistLatest()
  }

  flush(positionSeconds?: number, durationSeconds?: number): void {
    if (positionSeconds !== undefined && durationSeconds !== undefined) {
      this.latest = normalizedSnapshot(positionSeconds, durationSeconds)
    }
    this.clearRetry()
    if (this.inFlight) {
      this.flushAfterFlight = true
      return
    }
    if (this.latest !== null) void this.persistLatest(true)
  }

  dispose(positionSeconds?: number, durationSeconds?: number): void {
    this.flush(positionSeconds, durationSeconds)
    this.disposed = true
  }

  private async persistLatest(force = false): Promise<void> {
    if (this.latest === null || this.inFlight || (this.disposed && !force)) return
    const snapshot = this.latest
    this.inFlight = true
    this.lastAttemptAt = this.now()
    try {
      const response = await this.persist(snapshot)
      if (!response.success) {
        this.onStatus(response.error?.message === undefined
          ? '播放进度保存失败，将自动重试。'
          : `播放进度保存失败：${response.error.message}，将自动重试。`)
        this.scheduleRetry()
        return
      }
      if (this.latest === snapshot) this.latest = null
      this.onStatus('')
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason)
      this.onStatus(`播放进度保存失败：${message}，将自动重试。`)
      this.scheduleRetry()
    } finally {
      this.inFlight = false
      if (this.flushAfterFlight) {
        this.flushAfterFlight = false
        void this.persistLatest(true)
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || this.disposed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.persistLatest(true)
    }, VIDEO_PROGRESS_RETRY_MS)
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}

function normalizedSnapshot(positionSeconds: number, durationSeconds: number): ProgressSnapshot {
  return { positionSeconds: normalizeSeconds(positionSeconds), durationSeconds: normalizeSeconds(durationSeconds) }
}

function normalizeSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
