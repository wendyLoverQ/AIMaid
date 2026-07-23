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
  private cleanupPromise: Promise<void> | undefined
  private cleanupComplete = false
  private startupComplete = false
  private requestedExitCode: number | undefined
  private startupCoreError: {
    error: Error
    code: number | null
    signal: string | null
    lastError: string | undefined
  } | undefined
  private pendingStartupWindow: WindowKind | undefined
  private pendingStartupActivate = false

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
    try {
      this.petAssets.register()
      this.petWindows.install()
      this.tray.install()
      this.ipc.install()
      this.events.start()
      await this.coreProcess.start()
      await this.coreClient.start()
      this.throwIfStartupCoreFailed('CoreClient startup')
      if (this.coreClient.getStatus().state !== 'ready') {
        throw new Error(`Core failed to become ready: ${this.coreClient.getStatus().state}`)
      }
      await this.systemSettings.initialize()
      this.throwIfStartupCoreFailed('system settings initialization')
      this.reminders.start()
      const requestedWindow = this.readStartupWindow()
      const hidePet = process.argv.includes('--hide-pet')
      if (!hidePet) {
        this.throwIfStartupCoreFailed('before Pet window open')
        this.petWindows.open()
      }
      await this.systemSettings.applyVisualSettings()
      this.throwIfStartupCoreFailed('visual settings application')
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
      this.throwIfStartupCoreFailed('before startup completion')
      this.assertCoreReadyForStartupCompletion()
      this.startupComplete = true
      await this.processPendingWindowIntent()
      this.assertCoreReadyForStartupCompletion()
      this.log.info('startup', 'Application startup completed', {
        durationMs: elapsedMs(startupStartedAt),
        coreState: this.coreClient.getStatus().state,
        requestedWindow: requestedWindow ?? null,
        petVisible: !hidePet
      })
    } catch (error) {
      await this.cleanupAndExit(1)
      this.log.error('startup', 'Application startup failed', error)
    }
  }

  private readStartupWindow(argumentsList: readonly string[] = process.argv): WindowKind | undefined {
    if (argumentsList.includes('--show-workbench')) return 'main'
    const argument = argumentsList.find((value) => value.startsWith('--show-window='))
    const value = argument?.slice('--show-window='.length)
    if (!isWindowKind(value) || value === 'pet' || value === 'tray-menu' || value === 'agent-confirm') return undefined
    return value
  }

  private registerLifecycleHandlers(): void {
    this.coreProcess.on('exit', this.handleCoreExit)
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
      if (this.cleanupPromise !== undefined) return
      if (!this.startupComplete) {
        if (requested !== undefined) this.pendingStartupWindow = requested
        else this.pendingStartupActivate = true
        return
      }
      if (requested !== undefined) this.windows.open(requested)
      else this.windows.focus('pet')
    })
    app.on('activate', () => {
      if (this.cleanupPromise !== undefined) return
      if (!this.startupComplete) {
        this.pendingStartupActivate = true
        return
      }
      if (this.windows.get('pet') === undefined) this.petWindows.open()
      else this.windows.focus('pet')
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
    app.on('before-quit', (event) => {
      if (this.cleanupComplete) return
      event.preventDefault()
      void this.cleanupAndExit(0)
    })
  }

  private readonly handleCoreExit = (details: { code: number | null, signal: string | null, expected: boolean }): void => {
    if (details.expected || this.startupCoreError !== undefined) return
    const status = this.coreProcess.status
    const error = new Error(status.lastError ?? 'Core exited unexpectedly')
    this.startupCoreError = { error, code: details.code, signal: details.signal, lastError: status.lastError }
    this.log.error('lifecycle', this.startupComplete ? 'Core exited unexpectedly after application startup' : 'Core exited unexpectedly during application startup', error, {
      code: details.code,
      signal: details.signal,
      lastError: status.lastError
    })
    void this.cleanupAndExit(1)
  }

  handleFatalError(source: string, error: unknown): void {
    this.log.error('process', `Fatal process error: ${source}`, error)
    void this.cleanupAndExit(1)
  }

  private throwIfStartupCoreFailed(stage: string): void {
    if (this.startupCoreError !== undefined) throw new Error(`${stage} aborted: ${this.startupCoreError.error.message}`, { cause: this.startupCoreError.error })
  }

  private assertCoreReadyForStartupCompletion(): void {
    this.throwIfStartupCoreFailed('startup completion')
    const clientState = this.coreClient.getStatus().state
    const processState = this.coreProcess.status.state
    if (clientState !== 'ready' || processState !== 'ready') {
      throw new Error(`Core is no longer ready before startup completion (client=${clientState}, process=${processState})`)
    }
  }

  private async processPendingWindowIntent(): Promise<void> {
    const requestedWindow = this.pendingStartupWindow
    const activate = this.pendingStartupActivate
    this.pendingStartupWindow = undefined
    this.pendingStartupActivate = false
    if (requestedWindow !== undefined) {
      await this.windows.openAndWait(requestedWindow)
      return
    }
    if (activate) {
      if (this.windows.get('pet') === undefined) this.petWindows.open()
      else this.windows.focus('pet')
    }
  }

  private async cleanupAndExit(exitCode: number): Promise<void> {
    this.requestedExitCode = this.requestedExitCode === undefined ? exitCode : Math.max(this.requestedExitCode, exitCode)
    if (this.cleanupPromise !== undefined) return this.cleanupPromise
    this.cleanupPromise = this.performCleanup()
    return this.cleanupPromise
  }

  private async performCleanup(): Promise<void> {
    this.log.info('lifecycle', 'Application cleanup started')
    await this.cleanupStep('reminders', () => this.reminders.stop())
    await this.cleanupStep('event router', () => this.events.stop())
    await this.cleanupStep('IPC router', () => this.ipc.dispose())
    await this.cleanupStep('pet window manager', () => this.petWindows.dispose())
    await this.cleanupStep('tray', () => this.tray.dispose())
    await this.cleanupStep('pet assets', () => this.petAssets.dispose())
    await this.cleanupStep('system settings', () => this.systemSettings.dispose())
    await this.cleanupStep('windows', () => this.windows.destroyAll())
    await this.cleanupStep('Core client', () => this.coreClient.stop())
    await this.cleanupStep('Core process', () => this.coreProcess.stop())
    this.cleanupComplete = true
    this.log.info('lifecycle', 'Application cleanup complete')
    const exitCode = this.requestedExitCode ?? 0
    if (exitCode === 0) app.quit()
    else app.exit(exitCode)
  }

  private async cleanupStep(name: string, action: () => void | Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.log.error('lifecycle', `${name} cleanup failed`, error)
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
