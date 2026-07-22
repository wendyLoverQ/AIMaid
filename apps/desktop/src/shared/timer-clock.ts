export type ActiveTimerMode = 'countdown' | 'countup'

export interface TimerClockSnapshot {
  elapsedSeconds: number
  remainingSeconds: number
  completed: boolean
}

export function calculateTimerClock(mode: ActiveTimerMode, startedAt: number | null, elapsedAtStart: number, remainingAtStart: number, now: number): TimerClockSnapshot {
  const delta = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
  if (mode === 'countup') return { elapsedSeconds: elapsedAtStart + delta, remainingSeconds: 0, completed: false }
  const remainingSeconds = Math.max(0, remainingAtStart - delta)
  return {
    elapsedSeconds: elapsedAtStart + Math.min(delta, remainingAtStart),
    remainingSeconds,
    completed: remainingSeconds === 0
  }
}
