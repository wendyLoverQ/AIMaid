import { dialog, ipcMain } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { canRequest } from '../../shared/capabilities'
import { isCoreRequest } from '../../shared/core'
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
import type { CoreProcessManager } from '../core/core-process-manager'
import type { Logger } from '../logging/logger'
import type { WindowManager } from '../windows/window-manager'

interface ActiveRequest {
  controller: AbortController
  senderId: number
  timer: ReturnType<typeof setTimeout>
}

export class IpcRouter {
  private readonly activeRequests = new Map<string, ActiveRequest>()
  private readonly recentRequestIds = new Map<string, number>()
  private installed = false

  constructor(
    private readonly windows: WindowManager,
    private readonly coreClient: CoreClient,
    private readonly coreProcess: CoreProcessManager,
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
    this.recentRequestIds.clear()
    this.installed = false
  }

  private readonly handleInvoke = async (event: IpcMainInvokeEvent, value: unknown): Promise<IpcResponseEnvelope> => {
    if (!isIpcRequestEnvelope(value)) {
      this.log.warn('ipc', 'Rejected malformed or unknown request')
      throw new Error('Malformed or unknown IPC request')
    }
    const request = value
    const kind = this.authorize(event, request)
    if (kind === undefined) {
      return errorResponse(request, ipcError('IPC_FORBIDDEN', 'The sender is not authorized for this request'))
    }
    if (this.isDuplicate(request.requestId)) {
      return errorResponse(request, ipcError('IPC_DUPLICATE_REQUEST', 'The requestId has already been used'))
    }

    this.remember(request.requestId)
    try {
      const payload = await this.dispatch(event, kind, request)
      return successResponse(request, payload)
    } catch (error) {
      this.log.error('ipc', `Request failed: ${request.type}`, error)
      return errorResponse(request, toIpcError(error))
    }
  }

  private readonly handleSend = (event: IpcMainEvent, value: unknown): void => {
    if (!isIpcNotificationEnvelope(value) || !this.isTrusted(event)) return
    const active = this.activeRequests.get(value.requestId)
    if (active === undefined || active.senderId !== event.sender.id) return
    clearTimeout(active.timer)
    active.controller.abort(new Error('Request cancelled by renderer'))
    this.activeRequests.delete(value.requestId)
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
        this.windows.open(target)
        return { target }
      }
      case 'window.show':
        this.windows.show(sourceKind)
        return { window: sourceKind }
      case 'window.hide':
        this.windows.hide(sourceKind)
        return { window: sourceKind }
      case 'window.close':
        this.windows.close(sourceKind)
        return { window: sourceKind }
      case 'window.focus':
        this.windows.focus(sourceKind)
        return { window: sourceKind }
      case 'dialog.openFile': {
        const filters = readFilters(request.payload)
        const parent = this.windows.get(sourceKind)
        const result = parent === undefined
          ? await dialog.showOpenDialog({ properties: ['openFile'], filters })
          : await dialog.showOpenDialog(parent, { properties: ['openFile'], filters })
        return { canceled: result.canceled, filePaths: result.filePaths }
      }
      case 'core.status':
        return this.coreProcess.status
      case 'core.invoke':
        if (!isCoreRequest(request.payload)) throw new TypeError('Invalid Core request payload')
        return this.invokeCore(event.sender.id, request.requestId, request.payload)
    }
  }

  private async invokeCore(senderId: number, requestId: string, payload: Parameters<CoreClient['invoke']>[1]): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Core request timed out after 30000ms')), 30_000)
    this.activeRequests.set(requestId, { controller, senderId, timer })
    try {
      return await this.coreClient.invoke(requestId, payload, controller.signal)
    } finally {
      clearTimeout(timer)
      this.activeRequests.delete(requestId)
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
    if (!extensions.every((value) => typeof value === 'string' && /^[a-z0-9]+$/iu.test(value))) {
      throw new TypeError('Invalid file extension')
    }
    return { name: filter.name.slice(0, 80), extensions }
  })
}

function toIpcError(error: unknown): IpcError {
  if (error instanceof TypeError) return ipcError('IPC_INVALID_ARGUMENT', error.message)
  if (error instanceof Error && error.name === 'AbortError') return ipcError('IPC_CANCELLED', error.message, true)
  if (error instanceof Error) return ipcError('IPC_REQUEST_FAILED', error.message)
  return ipcError('IPC_REQUEST_FAILED', 'Unknown request failure')
}

function ipcError(code: string, message: string, retryable = false): IpcError {
  return { code, message, retryable }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
