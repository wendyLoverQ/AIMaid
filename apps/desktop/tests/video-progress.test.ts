import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcResponseEnvelope } from '../src/shared/ipc'
import { restoredPlaybackPosition, VIDEO_PROGRESS_INTERVAL_MS, VIDEO_PROGRESS_RETRY_MS, VideoProgressSession } from '../src/shared/video-progress'

const success = (): IpcResponseEnvelope => ({ requestId: 'test', type: 'core.invoke', payload: null, success: true, error: null, timestamp: 0 })
const failure = (): IpcResponseEnvelope => ({ requestId: 'test', type: 'core.invoke', payload: null, success: false, error: { code: 'TEST', message: '暂时不可用', retryable: true }, timestamp: 0 })

afterEach(() => vi.useRealTimers())

describe('video playback progress', () => {
  it('restores unfinished playback but starts completed or near-end media from the beginning', () => {
    expect(restoredPlaybackPosition(61, 600, false)).toBe(61)
    expect(restoredPlaybackPosition(590, 600, false)).toBe(0)
    expect(restoredPlaybackPosition(61, 600, true)).toBe(0)
  })

  it('throttles time updates and flushes the latest position', async () => {
    vi.useFakeTimers()
    let now = 0
    const persist = vi.fn(async () => success())
    const session = new VideoProgressSession(persist, () => undefined, () => now)
    session.update(1.8, 600.9)
    await vi.runAllTicks()
    now = VIDEO_PROGRESS_INTERVAL_MS - 1
    session.update(4, 600)
    expect(persist).toHaveBeenCalledTimes(1)
    session.flush(5.9, 600.9)
    await vi.runAllTicks()
    expect(persist).toHaveBeenLastCalledWith({ positionSeconds: 5, durationSeconds: 600 })
  })

  it('exposes a save failure and retries without a high-frequency loop', async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const persist = vi.fn().mockResolvedValueOnce(failure()).mockResolvedValueOnce(success())
    const session = new VideoProgressSession(persist, (status) => statuses.push(status), () => 0)
    session.update(12, 120)
    await vi.runAllTicks()
    expect(statuses.at(-1)).toContain('暂时不可用')
    expect(persist).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(VIDEO_PROGRESS_RETRY_MS)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)).toBe('')
  })
})
