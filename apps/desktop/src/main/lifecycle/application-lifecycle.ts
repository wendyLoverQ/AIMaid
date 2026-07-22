import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { CoreClient } from '../core/core-client'
import type { CoreProcessManager } from '../core/core-process-manager'
import type { EventRouter } from '../ipc/event-router'
import type { IpcRouter } from '../ipc/ipc-router'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'
import type { PetAssetService } from '../services/pet-asset-service'
import type { PetWindowManager } from '../windows/pet-window-manager'
import type { TrayController } from '../services/tray-controller'
import type { SystemSettingsService } from '../services/system-settings-service'
import type { ReminderScheduler } from '../services/reminder-scheduler'
import { isWindowKind } from '../../shared/windows'
import type { WindowKind } from '../../shared/windows'

export class ApplicationLifecycle {
  private cleanupStarted = false
  private cleanupComplete = false

  constructor(
    private readonly windows: WindowManager,
    private readonly ipc: IpcRouter,
    private readonly events: EventRouter,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager,
    private readonly petAssets: PetAssetService,
    private readonly petWindows: PetWindowManager,
    private readonly tray: TrayController,
    private readonly systemSettings: SystemSettingsService,
    private readonly reminders: ReminderScheduler,
    private readonly log: Logger
  ) {}

  async run(): Promise<void> {
    const startupStartedAt = performance.now()
    this.log.info('startup', 'Application startup began', {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      processId: process.pid
    })
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }

    this.registerLifecycleHandlers()
    await app.whenReady()
    this.petAssets.register()
    this.petWindows.install()
    this.tray.install()
    this.ipc.install()
    this.events.start()
    try {
      await this.coreProcess.start()
      await this.coreClient.start()
    } catch (error) {
      this.log.error('startup', 'Real Core failed to become ready', error)
    }
    if (this.coreClient.getStatus().state === 'ready') {
      try {
        await this.systemSettings.initialize()
      } catch (error) {
        this.log.error('startup', 'System settings initialization failed', error)
      }
      this.reminders.start()
    }
    const requestedWindow = this.readStartupWindow()
    const hidePet = process.argv.includes('--hide-pet')
    if (!hidePet) this.petWindows.open()
    await this.systemSettings.applyVisualSettings()
    if (requestedWindow !== undefined) {
      await this.windows.openAndWait(requestedWindow)
      this.log.info('startup', 'Window opened from explicit startup argument', { kind: requestedWindow, hidePet })
    }
    if (process.argv.includes('--smoke-test') || process.env.AIMAID_SMOKE_TEST === '1') {
      const requested = Number(process.env.AIMAID_SMOKE_TEST_MS ?? 1_000)
      const delay = Number.isFinite(requested) ? Math.min(30_000, Math.max(1_000, requested)) : 1_000
      if (delay >= 5_000) {
        setTimeout(() => {
          const controller = new AbortController()
          void this.coreClient.invoke(randomUUID(), { type: 'system.stream', payload: { steps: 4, delayMs: 250 } }, controller.signal)
            .catch((error: unknown) => this.log.error('smoke-test', 'Core PetWindow event test failed', error))
        }, 2_500).unref()
      }
      setTimeout(() => app.quit(), delay).unref()
    }
    this.log.info('startup', 'Application startup completed', {
      durationMs: elapsedMs(startupStartedAt),
      coreState: this.coreClient.getStatus().state,
      requestedWindow: requestedWindow ?? null,
      petVisible: !hidePet
    })
  }

  private readStartupWindow(argumentsList: readonly string[] = process.argv): WindowKind | undefined {
    if (argumentsList.includes('--show-workbench')) return 'main'
    const argument = argumentsList.find((value) => value.startsWith('--show-window='))
    const value = argument?.slice('--show-window='.length)
    if (!isWindowKind(value) || value === 'pet' || value === 'tray-menu' || value === 'agent-confirm') return undefined
    return value
  }

  private registerLifecycleHandlers(): void {
    app.on('child-process-gone', (_event, details) => {
      this.log.error('process', 'Electron child process gone', new Error(`${details.type} exited: ${details.reason}`), {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name
      })
    })
    app.on('second-instance', (_event, argumentsList) => {
      const requested = this.readStartupWindow(argumentsList)
      if (requested !== undefined) this.windows.open(requested)
      else this.windows.focus('pet')
    })
    app.on('activate', () => {
      if (this.windows.get('pet') === undefined) this.petWindows.open()
      else this.windows.focus('pet')
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
    await this.reminders.stop()
    this.events.stop()
    this.ipc.dispose()
    this.petWindows.dispose()
    this.tray.dispose()
    this.petAssets.dispose()
    this.systemSettings.dispose()
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

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
