import { app, globalShortcut } from 'electron'
import type { CoreClient } from '../core/core-client'
import type { CoreProcessManager } from '../core/core-process-manager'
import type { EventRouter } from '../ipc/event-router'
import type { IpcRouter } from '../ipc/ipc-router'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'

export class ApplicationLifecycle {
  private cleanupStarted = false
  private cleanupComplete = false

  constructor(
    private readonly windows: WindowManager,
    private readonly ipc: IpcRouter,
    private readonly events: EventRouter,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager,
    private readonly log: Logger
  ) {}

  async run(): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }

    this.registerLifecycleHandlers()
    await app.whenReady()
    this.ipc.install()
    await this.coreProcess.start()
    await this.coreClient.start()
    this.events.start()
    this.windows.open('main')
    this.windows.open('pet')
  }

  private registerLifecycleHandlers(): void {
    app.on('second-instance', () => this.windows.focus('main'))
    app.on('activate', () => {
      if (this.windows.get('main') === undefined) this.windows.open('main')
      else this.windows.focus('main')
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
    app.on('before-quit', (event) => {
      if (this.cleanupComplete) return
      event.preventDefault()
      if (!this.cleanupStarted) void this.cleanupAndExit()
    })
  }

  private async cleanupAndExit(): Promise<void> {
    this.cleanupStarted = true
    this.log.info('lifecycle', 'Application cleanup started')
    this.events.stop()
    this.ipc.dispose()
    globalShortcut.unregisterAll()
    this.windows.destroyAll()
    try {
      await this.coreClient.stop()
      await this.coreProcess.stop()
    } catch (error) {
      this.log.error('lifecycle', 'Core cleanup failed', error)
    } finally {
      this.cleanupComplete = true
      this.log.info('lifecycle', 'Application cleanup complete')
      app.quit()
    }
  }
}
