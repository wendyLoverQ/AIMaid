import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { isCoreEventType } from '../../shared/core'
import type { CoreEventType } from '../../shared/core'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcEventEnvelope } from '../../shared/ipc'
import { WINDOW_CAPABILITIES } from '../../shared/capabilities'
import type { CoreClient } from '../core/core-client'
import type { CoreProcessManager } from '../core/core-process-manager'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'

interface WindowSubscriptions {
  contents: WebContents
  subscriptions: Map<string, Set<CoreEventType>>
}

export class EventRouter {
  private cleanups: Array<() => void> = []
  private readonly windowsByContents = new Map<number, WindowSubscriptions>()

  constructor(
    private readonly windows: WindowManager,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager,
    private readonly log: Logger
  ) {}

  start(): void {
    this.cleanups.push(this.coreClient.subscribe((event) => this.broadcast(event)))
    const onStatus = (payload: unknown): void => this.broadcast(this.createEvent('core.status-changed', payload))
    const onStderr = (): void => this.broadcast(this.createEvent('core.stderr', { message: 'Core wrote a diagnostic entry.' }))
    const onExit = (payload: unknown): void => this.broadcast(this.createEvent('core.exit', payload))
    this.coreProcess.on('status', onStatus)
    this.coreProcess.on('stderr', onStderr)
    this.coreProcess.on('exit', onExit)
    this.cleanups.push(() => {
      this.coreProcess.off('status', onStatus)
      this.coreProcess.off('stderr', onStderr)
      this.coreProcess.off('exit', onExit)
    })
  }

  subscribe(contents: WebContents, subscriptionId: string, types: unknown): boolean {
    const kind = this.windows.kindFor(contents)
    if (kind === undefined || !WINDOW_CAPABILITIES[kind].events || !Array.isArray(types) || types.length === 0 ||
      types.length > 20 || !types.every(isCoreEventType)) return false
    let entry = this.windowsByContents.get(contents.id)
    if (entry === undefined) {
      entry = { contents, subscriptions: new Map() }
      this.windowsByContents.set(contents.id, entry)
      contents.once('destroyed', () => this.windowsByContents.delete(contents.id))
    }
    entry.subscriptions.set(subscriptionId, new Set(types))
    return true
  }

  unsubscribe(contentsId: number, subscriptionId: string): void {
    const entry = this.windowsByContents.get(contentsId)
    if (entry === undefined) return
    entry.subscriptions.delete(subscriptionId)
    if (entry.subscriptions.size === 0) this.windowsByContents.delete(contentsId)
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.windowsByContents.clear()
  }

  private broadcast(event: IpcEventEnvelope): void {
    if (event.type === 'music.playback.requested') this.windows.open('music-visualizer')
    else if (event.type === 'music.playback.stopped') this.windows.hide('music-visualizer')
    for (const [contentsId, entry] of this.windowsByContents) {
      if (entry.contents.isDestroyed()) {
        this.windowsByContents.delete(contentsId)
        continue
      }
      const interested = [...entry.subscriptions.values()].some((types) => types.has(event.type))
      if (!interested) continue
      try {
        entry.contents.send(IPC_CHANNELS.event, event)
      } catch (error) {
        this.log.error('event-router', 'Window event delivery failed', error)
      }
    }
  }

  private createEvent(type: IpcEventEnvelope['type'], payload: unknown): IpcEventEnvelope {
    return { requestId: randomUUID(), type, payload, success: true, error: null, timestamp: Date.now() }
  }
}
