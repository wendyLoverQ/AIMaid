import { describe, expect, it, vi } from 'vitest'
import type { ReminderDto } from '../src/shared/business'
import type { CoreRequest, CoreStatus } from '../src/shared/core'
import type { CoreClient, CoreEventListener } from '../src/main/core/core-client'
import type { Logger } from '../src/main/logging/logger'

vi.mock('electron', () => ({ Notification: class {} }))

import { ReminderScheduler } from '../src/main/services/reminder-scheduler'
import type { ReminderNotifier } from '../src/main/services/reminder-scheduler'

const dueReminder: ReminderDto = {
  reminderId: 'rem_1', title: '喝水', message: '该喝水了', dueAt: '2026-07-22T02:00:00.000Z',
  repeat: 'none', enabled: true, allowTts: false, lastTriggeredAt: null,
  nextDueAt: '2026-07-22T02:00:00.000Z', createdAt: '2026-07-22T01:00:00.000Z', updatedAt: '2026-07-22T01:00:00.000Z'
}

describe('ReminderScheduler', () => {
  it('does not overlap checks', async () => {
    let release!: (value: unknown) => void
    const core = fakeCore((_request) => new Promise((resolve) => { release = resolve }))
    const scheduler = createScheduler(core, { show: vi.fn(async () => undefined) })

    const first = scheduler.runNow()
    await Promise.resolve()
    await scheduler.runNow()
    expect(core.requests).toHaveLength(1)
    release([])
    await first
  })

  it('leaves a reminder due and retries when notification delivery fails', async () => {
    const core = fakeCore(async (request) => request.type === 'reminder.list' ? [dueReminder] : [])
    const notifier: ReminderNotifier = { show: vi.fn(async () => { throw new Error('notification failed') }) }
    const scheduler = createScheduler(core, notifier)

    await scheduler.runNow()
    await scheduler.runNow()

    expect(notifier.show).toHaveBeenCalledTimes(2)
    expect(core.requests.filter((request) => request.type === 'reminder.process_due')).toHaveLength(0)
  })

  it('completes only the reminder whose system notification was shown', async () => {
    const core = fakeCore(async (request) => request.type === 'reminder.list' ? [dueReminder] : [dueReminder])
    const notifier: ReminderNotifier = { show: vi.fn(async () => undefined) }
    const scheduler = createScheduler(core, notifier)

    await scheduler.runNow()

    expect(core.requests[1]).toEqual({
      type: 'reminder.process_due',
      payload: { now: '2026-07-22T03:00:00.000Z', reminderIds: ['rem_1'] }
    })
  })

  it('cancels its next timer and waits for an in-flight check during shutdown', async () => {
    let release!: (value: unknown) => void
    const core = fakeCore((_request) => new Promise((resolve) => { release = resolve }))
    const scheduled: Array<() => void> = []
    const cancelSchedule = vi.fn()
    const scheduler = new ReminderScheduler(core, { show: vi.fn(async () => undefined) }, silentLogger(), {
      now: () => new Date('2026-07-22T03:00:00.000Z'),
      schedule: (callback) => { scheduled.push(callback); return 1 as unknown as ReturnType<typeof setTimeout> },
      cancelSchedule
    })
    scheduler.start()
    scheduled[0]?.()
    await Promise.resolve()

    let stopped = false
    const stopping = scheduler.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release([])
    await stopping
    expect(cancelSchedule).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
  })
})

interface FakeCore extends CoreClient { requests: CoreRequest[] }

function fakeCore(handler: (request: CoreRequest) => Promise<unknown>): FakeCore {
  const requests: CoreRequest[] = []
  return {
    requests,
    start: async () => undefined,
    stop: async () => undefined,
    invoke: async (_requestId, request) => { requests.push(request); return handler(request) },
    cancel: async () => undefined,
    getStatus: (): CoreStatus => ({ state: 'ready', implementation: 'real', processId: 1, startedAt: Date.now() }),
    subscribe: (_listener: CoreEventListener) => () => undefined
  }
}

function createScheduler(core: CoreClient, notifier: ReminderNotifier): ReminderScheduler {
  return new ReminderScheduler(core, notifier, silentLogger(), {
    now: () => new Date('2026-07-22T03:00:00.000Z'),
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    cancelSchedule: () => undefined
  })
}

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}
