import { randomUUID } from 'node:crypto'
import { Notification } from 'electron'
import type { ReminderDto } from '../../shared/business'
import type { CoreClient } from '../core/core-client'
import type { Logger } from '../logging/logger'

export interface ReminderNotifier {
  show(reminder: ReminderDto): Promise<void>
}

export interface ReminderSchedulerOptions {
  intervalMs?: number
  now?: () => Date
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_INTERVAL_MS = 15_000

export class NativeReminderNotifier implements ReminderNotifier {
  async show(reminder: ReminderDto): Promise<void> {
    if (!Notification.isSupported()) throw new Error('当前系统不支持 Electron 通知。')
    await new Promise<void>((resolve, reject) => {
      const notification = new Notification({ title: reminder.title, body: reminder.message, silent: false })
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('系统通知显示确认超时。'))
      }, 5_000)
      timeout.unref()
      const shown = (): void => { cleanup(); resolve() }
      const failed = (_event: Electron.Event, error: string): void => { cleanup(); reject(new Error(error || '系统通知显示失败。')) }
      const cleanup = (): void => {
        clearTimeout(timeout)
        notification.off('show', shown)
        notification.off('failed', failed)
      }
      notification.once('show', shown)
      notification.once('failed', failed)
      notification.show()
    })
  }
}

export class ReminderScheduler {
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private processing = false
  private stopping: Promise<void> | undefined
  private resolveStopping: (() => void) | undefined

  constructor(
    private readonly core: CoreClient,
    private readonly notifier: ReminderNotifier,
    private readonly log: Logger,
    options: ReminderSchedulerOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.now = options.now ?? (() => new Date())
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.log.info('reminder-scheduler', 'Reminder scheduler started', { intervalMs: this.intervalMs })
    this.queueNext(0)
  }

  async stop(): Promise<void> {
    if (!this.running && !this.processing) return
    this.running = false
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer)
      this.timer = undefined
    }
    if (this.processing) {
      this.stopping ??= new Promise<void>((resolve) => { this.resolveStopping = resolve })
      await this.stopping
    }
    this.log.info('reminder-scheduler', 'Reminder scheduler stopped')
  }

  async runNow(): Promise<void> {
    if (this.processing) {
      this.log.debug('reminder-scheduler', 'Reminder check skipped because the previous check is still running')
      return
    }
    this.processing = true
    const startedAt = performance.now()
    try {
      const now = this.now()
      const payload = await this.core.invoke(randomUUID(), { type: 'reminder.list', payload: {} }, new AbortController().signal)
      const due = readReminders(payload)
        .filter((item) => item.enabled && Date.parse(item.nextDueAt ?? item.dueAt) <= now.getTime())
        .sort((left, right) => Date.parse(left.nextDueAt ?? left.dueAt) - Date.parse(right.nextDueAt ?? right.dueAt))
        .slice(0, 5)
      this.log.debug('reminder-scheduler', 'Reminder check completed', {
        dueCount: due.length,
        durationMs: elapsedMs(startedAt)
      })
      for (const reminder of due) await this.consume(reminder, now)
    } catch (error) {
      this.log.error('reminder-scheduler', 'Reminder check failed; due reminders will be retried', error, {
        durationMs: elapsedMs(startedAt)
      })
    } finally {
      this.processing = false
      this.resolveStopping?.()
      this.resolveStopping = undefined
      this.stopping = undefined
      if (this.running) this.queueNext(this.intervalMs)
    }
  }

  private async consume(reminder: ReminderDto, now: Date): Promise<void> {
    const context = {
      reminderId: reminder.reminderId,
      dueAt: reminder.nextDueAt ?? reminder.dueAt,
      repeat: reminder.repeat,
      allowTts: reminder.allowTts
    }
    try {
      await this.notifier.show(reminder)
      this.log.info('reminder-scheduler', 'Due reminder system notification shown', context)
      await this.core.invoke(randomUUID(), {
        type: 'reminder.process_due',
        payload: { now: now.toISOString(), reminderIds: [reminder.reminderId] }
      }, new AbortController().signal)
      this.log.info('reminder-scheduler', 'Due reminder completed by Core after notification', context)
      if (reminder.allowTts) {
        this.log.info('reminder-scheduler', 'Reminder TTS delegated through reminder.due to the pet renderer', {
          reminderId: reminder.reminderId
        })
      }
    } catch (error) {
      this.log.error('reminder-scheduler', 'Due reminder consumption failed; reminder remains eligible for retry', error, context)
    }
  }

  private queueNext(delayMs: number): void {
    this.timer = this.schedule(() => {
      this.timer = undefined
      void this.runNow()
    }, delayMs)
    this.timer.unref?.()
  }
}

function readReminders(value: unknown): ReminderDto[] {
  if (!Array.isArray(value)) throw new TypeError('reminder.list 返回格式无效。')
  if (!value.every(isReminderDto)) throw new TypeError('reminder.list 包含格式无效的提醒。')
  return value
}

function isReminderDto(value: unknown): value is ReminderDto {
  if (typeof value !== 'object' || value === null) return false
  const reminder = value as Record<string, unknown>
  return typeof reminder.reminderId === 'string' && typeof reminder.title === 'string' &&
    typeof reminder.message === 'string' && typeof reminder.dueAt === 'string' &&
    (reminder.repeat === 'none' || reminder.repeat === 'daily') && typeof reminder.enabled === 'boolean' &&
    typeof reminder.allowTts === 'boolean' && (reminder.nextDueAt === null || typeof reminder.nextDueAt === 'string')
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
