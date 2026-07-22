import { app, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import { canRequest } from '../../shared/capabilities'
import { coreRequestTimeoutMs, isCoreRequest } from '../../shared/core'
import {
  IPC_CHANNELS,
  errorResponse,
  isIpcNotificationEnvelope,
  isIpcRequestEnvelope,
  successResponse
} from '../../shared/ipc'
import type { IpcError, IpcRequestEnvelope, IpcResponseEnvelope } from '../../shared/ipc'
import { isWindowKind } from '../../shared/windows'
import type { WindowKind } from '../../shared/windows'
import type { CoreClient } from '../core/core-client'
import { CoreClientError, CoreRemoteError } from '../core/stdio-core-client'
import type { CoreProcessManager } from '../core/core-process-manager'
import type { EventRouter } from './event-router'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'
import type { PetAssetService } from '../services/pet-asset-service'
import type { PetWindowManager } from '../windows/pet-window-manager'
import type { PetPerformanceMetrics, PetVisualBounds, PetWindowUpdate } from '../../shared/pet'
import { isPetPresentationAction } from '../../shared/presentation'
import type { PetPresentationService } from '../services/pet-presentation-service'
import type { DouyinSessionService } from '../services/douyin-session-service'
import type { NotebookAttachmentService } from '../services/notebook-attachment-service'
import type { SystemSettingsService } from '../services/system-settings-service'
import type { AgentConfirmationCoordinator } from '../services/agent-confirmation-coordinator'
import type { SpeechAudioService } from '../services/speech-audio-service'

interface ActiveRequest {
  controller: AbortController
  senderId: number
  timer: ReturnType<typeof setTimeout>
}

interface HighFrequencyLogStats {
  count: number
  lastLoggedAt: number
}

const HIGH_FREQUENCY_IPC_TYPES = new Set(['pet.dragMove', 'pet.reportMetrics', 'pet.reportVisualBounds', 'pet.setIgnoreMouseEvents', 'pet.updateWindow'])
const HIGH_FREQUENCY_LOG_INTERVAL_MS = 10_000

export class IpcRouter {
  private readonly activeRequests = new Map<string, ActiveRequest>()
  private readonly recentRequestIds = new Map<string, number>()
  private readonly requestOwners = new Map<string, number>()
  private readonly highFrequencyLogStats = new Map<string, HighFrequencyLogStats>()
  private restartPromise: Promise<void> | undefined
  private installed = false

  constructor(
    private readonly windows: WindowManager,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager,
    private readonly events: EventRouter,
    private readonly petAssets: PetAssetService,
    private readonly petWindows: PetWindowManager,
    private readonly petPresentation: PetPresentationService,
    private readonly douyinSession: DouyinSessionService,
    private readonly notebookAttachments: NotebookAttachmentService,
    private readonly speechAudio: SpeechAudioService,
    private readonly systemSettings: SystemSettingsService,
    private readonly agentConfirmation: AgentConfirmationCoordinator,
    private readonly log: Logger
  ) {}

  install(): void {
    if (this.installed) return
    ipcMain.handle(IPC_CHANNELS.invoke, this.handleInvoke)
    ipcMain.on(IPC_CHANNELS.send, this.handleSend)
    this.installed = true
  }

  dispose(): void {
    if (!this.installed) return
    ipcMain.removeHandler(IPC_CHANNELS.invoke)
    ipcMain.off(IPC_CHANNELS.send, this.handleSend)
    for (const request of this.activeRequests.values()) {
      clearTimeout(request.timer)
      request.controller.abort(new Error('Application is shutting down'))
    }
    this.activeRequests.clear()
    this.agentConfirmation.cancelAll('应用正在退出。')
    this.recentRequestIds.clear()
    this.requestOwners.clear()
    this.highFrequencyLogStats.clear()
    this.installed = false
  }

  private readonly handleInvoke = async (event: IpcMainInvokeEvent, value: unknown): Promise<IpcResponseEnvelope> => {
    const startedAt = performance.now()
    if (!isIpcRequestEnvelope(value)) {
      this.log.warn('ipc', 'Rejected malformed or unknown request', { senderId: event.sender.id })
      throw new Error('Malformed or unknown IPC request')
    }
    const request = value
    const kind = this.authorize(event, request)
    if (kind === undefined) {
      this.log.warn('ipc', 'Rejected unauthorized request', {
        requestId: request.requestId,
        type: request.type,
        senderId: event.sender.id,
        durationMs: elapsedMs(startedAt)
      })
      return errorResponse(request, ipcError('IPC_FORBIDDEN', 'The sender is not authorized for this request'))
    }
    if (this.isDuplicate(request.requestId)) {
      return errorResponse(request, ipcError('IPC_DUPLICATE_REQUEST', 'The requestId has already been used'))
    }

    this.remember(request.requestId)
    const isHighFrequency = HIGH_FREQUENCY_IPC_TYPES.has(request.type)
    if (!isHighFrequency) {
      this.log.info('ipc', 'IPC request started', {
        requestId: request.requestId,
        type: request.type,
        sourceWindow: kind,
        senderId: event.sender.id
      })
    }
    try {
      const payload = await this.dispatch(event, kind, request)
      const durationMs = elapsedMs(startedAt)
      if (isHighFrequency) this.logHighFrequencySummary(request.type, kind, event.sender.id, request.requestId, durationMs)
      else {
        this.log.info('ipc', 'IPC request completed', {
          requestId: request.requestId,
          type: request.type,
          sourceWindow: kind,
          senderId: event.sender.id,
          success: true,
          durationMs
        })
      }
      return successResponse(request, payload)
    } catch (error) {
      this.log.error('ipc', 'IPC request failed', error, {
        requestId: request.requestId,
        type: request.type,
        sourceWindow: kind,
        senderId: event.sender.id,
        success: false,
        durationMs: elapsedMs(startedAt)
      })
      return errorResponse(request, toIpcError(error))
    }
  }

  private logHighFrequencySummary(type: string, sourceWindow: WindowKind, senderId: number, requestId: string, durationMs: number): void {
    const now = Date.now()
    const stats = this.highFrequencyLogStats.get(type) ?? { count: 0, lastLoggedAt: 0 }
    stats.count += 1
    if (now - stats.lastLoggedAt < HIGH_FREQUENCY_LOG_INTERVAL_MS) {
      this.highFrequencyLogStats.set(type, stats)
      return
    }
    this.log.debug('ipc-sampled', 'High-frequency IPC activity', {
      type,
      sourceWindow,
      senderId,
      lastRequestId: requestId,
      sampleCount: stats.count,
      intervalMs: stats.lastLoggedAt === 0 ? 0 : now - stats.lastLoggedAt,
      lastDurationMs: durationMs
    })
    stats.count = 0
    stats.lastLoggedAt = now
    this.highFrequencyLogStats.set(type, stats)
  }

  private readonly handleSend = (event: IpcMainEvent, value: unknown): void => {
    if (!isIpcNotificationEnvelope(value) || !this.isTrusted(event)) return
    if (value.type === 'event.subscribe') {
      if (isRecord(value.payload)) this.events.subscribe(event.sender, value.requestId, value.payload.types)
      return
    }
    if (value.type === 'event.unsubscribe') {
      this.events.unsubscribe(event.sender.id, value.requestId)
      return
    }
    if (this.requestOwners.get(value.requestId) !== event.sender.id) return
    const active = this.activeRequests.get(value.requestId)
    if (active !== undefined && active.senderId === event.sender.id) {
      clearTimeout(active.timer)
      active.controller.abort(abortError('Request cancelled by renderer'))
      this.activeRequests.delete(value.requestId)
    } else {
      void this.coreClient.cancel(value.requestId).catch((error: unknown) => this.log.error('ipc', 'Core cancellation failed', error))
    }
  }

  private authorize(event: IpcMainInvokeEvent, request: IpcRequestEnvelope): WindowKind | undefined {
    if (!this.isTrusted(event)) return undefined
    const kind = this.windows.kindFor(event.sender)
    return kind !== undefined && canRequest(kind, request.type) ? kind : undefined
  }

  private isTrusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    const frame = event.senderFrame
    return frame !== null && frame === event.sender.mainFrame && this.windows.isTrusted(event.sender, frame.url)
  }

  private async dispatch(
    event: IpcMainInvokeEvent,
    sourceKind: WindowKind,
    request: IpcRequestEnvelope
  ): Promise<unknown> {
    switch (request.type) {
      case 'window.open': {
        const target = readTarget(request.payload)
        await this.windows.openAndWait(target, sourceKind, {
          requestId: request.requestId,
          sourceWindow: sourceKind,
          trigger: request.type,
          ...(sourceKind === 'pet' ? { petDisplayMode: this.petPresentation.snapshot().mode } : {})
        })
        return { target }
      }
      case 'window.show':
        if (sourceKind === 'pet') this.petWindows.show({ requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        else this.windows.show(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        return { window: sourceKind }
      case 'window.hide':
        if (sourceKind === 'pet') this.petWindows.hide({ requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        else this.windows.hide(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        return { window: sourceKind }
      case 'window.close':
        this.windows.close(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        return { window: sourceKind }
      case 'window.quit':
        setImmediate(() => app.quit())
        return { quitting: true }
      case 'window.focus':
        this.windows.focus(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        return { window: sourceKind }
      case 'window.minimize':
        this.windows.minimize(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type })
        return { window: sourceKind }
      case 'window.toggleMaximize':
        return { maximized: this.windows.toggleMaximize(sourceKind, { requestId: request.requestId, sourceWindow: sourceKind, trigger: request.type }) }
      case 'dialog.openFile': {
        const filters = readFilters(request.payload)
        const multiSelect = readOptionalBoolean(request.payload, 'multiSelect')
        const parent = this.windows.get(sourceKind)
        const properties: OpenDialogOptions['properties'] = multiSelect ? ['openFile', 'multiSelections'] : ['openFile']
        const result = parent === undefined
          ? await dialog.showOpenDialog({ properties, filters })
          : await dialog.showOpenDialog(parent, { properties, filters })
        return { canceled: result.canceled, filePaths: result.filePaths }
      }
      case 'dialog.openDirectory': {
        const parent = this.windows.get(sourceKind)
        const options: OpenDialogOptions = { properties: ['openDirectory'] }
        const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options)
        return { canceled: result.canceled, filePaths: result.filePaths }
      }
      case 'dialog.saveFile': {
        const values = readSaveFile(request.payload)
        const parent = this.windows.get(sourceKind)
        const options = { defaultPath: values.defaultPath, filters: values.filters }
        const result = parent === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(parent, options)
        return { canceled: result.canceled, filePath: result.filePath }
      }
      case 'shell.showItemInFolder': {
        const filePath = readString(request.payload, 'filePath', 32768)
        shell.showItemInFolder(filePath)
        return { shown: true }
      }
      case 'shell.openExternal': {
        const url = readString(request.payload, 'url', 8192)
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('Invalid external URL')
        await shell.openExternal(parsed.toString())
        return { opened: true }
      }
      case 'media.registerLocalFile':
        return { url: this.petAssets.registerExternalFile(readString(request.payload, 'filePath', 32768)) }
      case 'notebook.attachment.importFile':
        return this.notebookAttachments.importFile(readString(request.payload, 'filePath', 32768))
      case 'notebook.attachment.importData':
        return this.notebookAttachments.importData(
          readString(request.payload, 'name', 260),
          readString(request.payload, 'dataUrl', 36_000_000)
        )
      case 'notebook.attachment.action': {
        const action = readNotebookAttachmentAction(request.payload)
        await this.notebookAttachments.action(action, readString(request.payload, 'path', 32768), this.windows.get(sourceKind))
        return { action }
      }
      case 'speech.audio.importData':
        return this.speechAudio.importData(readString(request.payload, 'dataUrl', 36_000_000))
      case 'tray.action': {
        const action = readTrayAction(request.payload)
        this.windows.hide('tray-menu')
        if (action === 'show') this.petWindows.show()
        else if (action === 'reset-position') this.petWindows.resetPosition()
        else if (action === 'hide') this.petWindows.hide()
        else setImmediate(() => app.quit())
        return { action }
      }
      case 'douyin.session.save':
        return this.douyinSession.saveMetadata()
      case 'douyin.session.inspect':
        return this.douyinSession.inspect()
      case 'douyin.session.clear':
        await this.douyinSession.clear()
        return { cleared: true }
      case 'agent.confirmation.get':
        return this.agentConfirmation.current()
      case 'agent.confirmation.resolve':
        return { resolved: this.agentConfirmation.resolveCurrent(readString(request.payload, 'requestId', 100), readBoolean(request.payload, 'approved')) }
      case 'core.status':
        return this.coreClient.getStatus()
      case 'core.restart':
        await this.restartCore()
        return this.coreClient.getStatus()
      case 'system.settings.get':
        return this.systemSettings.getSnapshot()
      case 'system.settings.setAutoStart':
        return this.systemSettings.setAutoStart(readBoolean(request.payload, 'enabled'))
      case 'system.settings.setHotkey':
        if (!isRecord(request.payload)) throw new TypeError('Invalid hotkey payload')
        return this.systemSettings.setHotkey(request.payload.action, request.payload.gesture)
      case 'system.settings.setBubbleStyle':
        return this.systemSettings.setBubbleStyle(readStringAllowEmpty(request.payload, 'style', 16))
      case 'core.invoke':
        if (!isCoreRequest(request.payload)) throw new TypeError('Invalid Core request payload')
        return this.invokeCore(event.sender.id, request.requestId, request.payload)
      case 'pet.ready':
        this.petWindows.rendererReady(event.sender)
        return { ready: true }
      case 'pet.getAssetManifest':
        return this.petAssets.getManifest(readString(request.payload, 'modelId', 200))
      case 'pet.setIgnoreMouseEvents':
        this.petWindows.setIgnoreMouseEvents(event.sender, readBoolean(request.payload, 'ignore'))
        return { updated: true }
      case 'pet.dragStart':
        this.petWindows.dragStart(event.sender)
        return { started: true }
      case 'pet.dragMove':
        return { bounds: this.petWindows.dragMove(event.sender) }
      case 'pet.dragEnd':
        return { bounds: this.petWindows.dragEnd(event.sender) }
      case 'pet.updateWindow':
        return { bounds: this.petWindows.updateWindow(event.sender, readPetWindowUpdate(request.payload)) }
      case 'pet.reportVisualBounds':
        this.petWindows.reportVisualBounds(event.sender, readPetVisualBounds(request.payload))
        return { recorded: true }
      case 'pet.reportMetrics':
        this.petWindows.reportMetrics(event.sender, readPetMetrics(request.payload))
        return { recorded: true }
      case 'pet.runtime.get':
        return this.petWindows.runtimeStatus()
      case 'pet.presentation.get':
        return this.petPresentation.snapshot()
      case 'pet.presentation.execute': {
        if (!isRecord(request.payload) || !isPetPresentationAction(request.payload.action)) throw new TypeError('Invalid presentation action')
        const parent = this.windows.get('pet')
        if (parent === undefined) throw new Error('PetWindow is unavailable')
        return this.petPresentation.execute(request.payload.action, parent)
      }
    }
  }

  private async invokeCore(senderId: number, requestId: string, payload: Parameters<CoreClient['invoke']>[1]): Promise<unknown> {
    const controller = new AbortController()
    const timeoutMs = coreRequestTimeoutMs(payload.type)
    const timer = setTimeout(() => controller.abort(abortError(`Core request timed out after ${timeoutMs}ms`)), timeoutMs)
    this.activeRequests.set(requestId, { controller, senderId, timer })
    this.requestOwners.set(requestId, senderId)
    setTimeout(() => this.requestOwners.delete(requestId), 300_000).unref()
    try {
      return payload.type === 'agent.execute'
        ? await this.agentConfirmation.execute(payload.payload, controller.signal)
        : await this.coreClient.invoke(requestId, payload, controller.signal)
    } finally {
      clearTimeout(timer)
      this.activeRequests.delete(requestId)
    }
  }

  private async restartCore(): Promise<void> {
    if (this.restartPromise !== undefined) return this.restartPromise
    this.restartPromise = (async () => {
      this.agentConfirmation.cancelAll('Core 正在重启。')
      await this.coreClient.stop()
      await this.coreProcess.stop()
      await this.coreProcess.start()
      await this.coreClient.start()
    })()
    try {
      await this.restartPromise
    } finally {
      this.restartPromise = undefined
    }
  }

  private isDuplicate(requestId: string): boolean {
    return this.activeRequests.has(requestId) || this.recentRequestIds.has(requestId)
  }

  private remember(requestId: string): void {
    const expiresAt = Date.now() + 60_000
    this.recentRequestIds.set(requestId, expiresAt)
    setTimeout(() => {
      if ((this.recentRequestIds.get(requestId) ?? 0) <= Date.now()) this.recentRequestIds.delete(requestId)
    }, 60_100).unref()
  }
}

function readNotebookAttachmentAction(payload: unknown): 'copy' | 'openLocation' | 'saveAs' {
  const action = readString(payload, 'action', 32)
  if (action !== 'copy' && action !== 'openLocation' && action !== 'saveAs') throw new TypeError('Invalid notebook image action')
  return action
}

function readTarget(payload: unknown): WindowKind {
  if (!isRecord(payload) || !isWindowKind(payload.target)) throw new TypeError('Invalid target window')
  return payload.target
}

function readFilters(payload: unknown): Array<{ name: string; extensions: string[] }> {
  if (!isRecord(payload) || payload.filters === undefined) return []
  if (!Array.isArray(payload.filters) || payload.filters.length > 20) throw new TypeError('Invalid file filters')
  return payload.filters.map((filter) => {
    if (!isRecord(filter) || typeof filter.name !== 'string' || !Array.isArray(filter.extensions)) {
      throw new TypeError('Invalid file filter')
    }
    const extensions = filter.extensions
    if (!extensions.every((value) => typeof value === 'string' && /^(?:\*|[a-z0-9]+)$/iu.test(value))) {
      throw new TypeError('Invalid file extension')
    }
    return { name: filter.name.slice(0, 80), extensions }
  })
}

function readSaveFile(payload: unknown): { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> } {
  if (!isRecord(payload) || typeof payload.defaultPath !== 'string' || payload.defaultPath.length > 260) throw new TypeError('Invalid save path')
  return { defaultPath: payload.defaultPath, filters: readFilters({ filters: payload.filters }) }
}

function readBoolean(payload: unknown, key: string): boolean {
  if (!isRecord(payload) || typeof payload[key] !== 'boolean') throw new TypeError(`Invalid ${key}`)
  return payload[key]
}

function readOptionalBoolean(payload: unknown, key: string): boolean {
  if (!isRecord(payload) || payload[key] === undefined) return false
  if (typeof payload[key] !== 'boolean') throw new TypeError(`Invalid ${key}`)
  return payload[key]
}

function readString(payload: unknown, key: string, maximumLength: number): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string') throw new TypeError(`Invalid ${key}`)
  const value = payload[key].trim()
  if (value.length === 0 || value.length > maximumLength) throw new TypeError(`Invalid ${key}`)
  return value
}

function readStringAllowEmpty(payload: unknown, key: string, maximumLength: number): string {
  if (!isRecord(payload) || typeof payload[key] !== 'string' || payload[key].length > maximumLength) throw new TypeError(`Invalid ${key}`)
  return payload[key].trim()
}

function readTrayAction(payload: unknown): 'show' | 'reset-position' | 'hide' | 'quit' {
  if (!isRecord(payload) || (payload.action !== 'show' && payload.action !== 'reset-position' && payload.action !== 'hide' && payload.action !== 'quit')) {
    throw new TypeError('Invalid tray action')
  }
  return payload.action
}

function readPetMetrics(payload: unknown): PetPerformanceMetrics {
  if (!isRecord(payload) || typeof payload.state !== 'string') throw new TypeError('Invalid Pet metrics')
  const numberFields = [
    'fps', 'averageFrameMs', 'p95FrameMs', 'maximumFrameMs', 'loadTimeMs', 'windowWidth', 'windowHeight',
    'canvasWidth', 'canvasHeight', 'backingWidth', 'backingHeight', 'renderPixelRatio', 'resizeCount'
  ]
  if (!numberFields.every((field) => typeof payload[field] === 'number' && Number.isFinite(payload[field])) ||
    typeof payload.contextLost !== 'boolean') throw new TypeError('Invalid Pet metrics')
  return payload as unknown as PetPerformanceMetrics
}

function readPetWindowUpdate(payload: unknown): PetWindowUpdate {
  if (!isRecord(payload) || (payload.anchor !== 'top-left' && payload.anchor !== 'center')) {
    throw new TypeError('Invalid Pet window update')
  }
  for (const field of ['x', 'y', 'scale'] as const) {
    const value = payload[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000)) {
      throw new TypeError(`Invalid Pet window ${field}`)
    }
  }
  const scale = payload.scale
  if (scale !== undefined && (typeof scale !== 'number' || scale <= 0)) throw new TypeError('Invalid Pet window scale')
  return payload as unknown as PetWindowUpdate
}

function readPetVisualBounds(payload: unknown): PetVisualBounds {
  if (!isRecord(payload)) throw new TypeError('Invalid pet visual bounds payload')
  const values = ['x', 'y', 'width', 'height'].map((key) => payload[key])
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      (values[2] as number) <= 0 || (values[3] as number) <= 0) {
    throw new TypeError('Invalid pet visual bounds payload')
  }
  const anchorX = payload.anchorX
  const anchorY = payload.anchorY
  if ((anchorX === undefined) !== (anchorY === undefined) ||
      (anchorX !== undefined && (typeof anchorX !== 'number' || !Number.isFinite(anchorX))) ||
      (anchorY !== undefined && (typeof anchorY !== 'number' || !Number.isFinite(anchorY)))) {
    throw new TypeError('Invalid pet visual anchor payload')
  }
  return {
    x: values[0] as number,
    y: values[1] as number,
    width: values[2] as number,
    height: values[3] as number,
    ...(anchorX === undefined ? {} : { anchorX, anchorY: anchorY as number })
  }
}

function toIpcError(error: unknown): IpcError {
  if (error instanceof TypeError) return ipcError('IPC_INVALID_ARGUMENT', error.message)
  if (error instanceof CoreRemoteError) {
    return { code: error.code, message: error.message, retryable: false, details: error.details }
  }
  if (error instanceof CoreClientError) return ipcError(error.code, error.message, error.code === 'REQUEST_TIMEOUT')
  if (error instanceof Error && error.name === 'AbortError') return ipcError('IPC_CANCELLED', error.message, true)
  if (error instanceof Error) return ipcError('IPC_REQUEST_FAILED', error.message)
  return ipcError('IPC_REQUEST_FAILED', 'Unknown request failure')
}

function ipcError(code: string, message: string, retryable = false): IpcError {
  return { code, message, retryable }
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
