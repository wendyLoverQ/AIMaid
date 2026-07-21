import { randomUUID } from 'node:crypto'
import { IPC_CHANNELS } from '../../shared/ipc'
import type { IpcEventEnvelope } from '../../shared/ipc'
import { WINDOW_CAPABILITIES } from '../../shared/capabilities'
import type { CoreClient } from '../core/core-client'
import type { CoreProcessManager } from '../core/core-process-manager'
import type { WindowManager } from '../windows/window-manager'

export class EventRouter {
  private cleanups: Array<() => void> = []

  constructor(
    private readonly windows: WindowManager,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager
  ) {}

  start(): void {
    this.cleanups.push(this.coreClient.subscribe((event) => this.broadcast(event)))

    const onStatus = (payload: unknown): void => this.broadcast(this.createEvent('core.status-changed', payload))
    const onStdout = (payload: unknown): void => this.broadcast(this.createEvent('core.stdout', payload))
    const onStderr = (payload: unknown): void => this.broadcast(this.createEvent('core.stderr', payload))
    const onExit = (payload: unknown): void => this.broadcast(this.createEvent('core.exit', payload))
    this.coreProcess.on('status', onStatus)
    this.coreProcess.on('stdout', onStdout)
    this.coreProcess.on('stderr', onStderr)
    this.coreProcess.on('exit', onExit)
    this.cleanups.push(() => {
      this.coreProcess.off('status', onStatus)
      this.coreProcess.off('stdout', onStdout)
      this.coreProcess.off('stderr', onStderr)
      this.coreProcess.off('exit', onExit)
    })
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
  }

  private broadcast(event: IpcEventEnvelope): void {
    this.windows.forEach((kind, window) => {
      if (WINDOW_CAPABILITIES[kind].events && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.event, event)
      }
    })
  }

  private createEvent(type: IpcEventEnvelope['type'], payload: unknown): IpcEventEnvelope {
    return { requestId: randomUUID(), type, payload, success: true, error: null, timestamp: Date.now() }
  }
}
