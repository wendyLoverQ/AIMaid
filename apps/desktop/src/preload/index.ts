import { contextBridge, ipcRenderer } from 'electron'
import type { AIMaidApi, Unsubscribe } from '../shared/api'
import { WINDOW_CAPABILITIES, canRequest } from '../shared/capabilities'
import type { CoreRequest, CoreStatus } from '../shared/core'
import { IPC_CHANNELS } from '../shared/ipc'
import type {
  IpcEventEnvelope,
  IpcNotificationEnvelope,
  IpcRequestEnvelope,
  IpcRequestType,
  IpcResponseEnvelope
} from '../shared/ipc'
import { isWindowKind } from '../shared/windows'
import type { WindowKind } from '../shared/windows'

const windowKind = readWindowKind(process.argv)
const subscriptions = new Set<Unsubscribe>()

function invoke<T = unknown>(type: IpcRequestType, payload: unknown, timeoutMs = 10_000): Promise<IpcResponseEnvelope<T>> {
  if (!canRequest(windowKind, type)) return Promise.resolve(forbiddenResponse<T>(type))
  const request: IpcRequestEnvelope = { requestId: createRequestId(), type, payload, timestamp: Date.now() }
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cancel(request.requestId)
      resolve({
        requestId: request.requestId,
        type,
        payload: null,
        success: false,
        error: { code: 'IPC_TIMEOUT', message: `Request timed out after ${timeoutMs}ms`, retryable: true },
        timestamp: Date.now()
      })
    }, clampTimeout(timeoutMs))

    void ipcRenderer.invoke(IPC_CHANNELS.invoke, request).then(
      (response: IpcResponseEnvelope<T>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(response)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          requestId: request.requestId,
          type,
          payload: null,
          success: false,
          error: { code: 'IPC_TRANSPORT_ERROR', message: error instanceof Error ? error.message : String(error), retryable: true },
          timestamp: Date.now()
        })
      }
    )
  })
}

function cancel(requestId: string): void {
  const notification: IpcNotificationEnvelope = {
    requestId,
    type: 'request.cancel',
    payload: null,
    timestamp: Date.now()
  }
  ipcRenderer.send(IPC_CHANNELS.send, notification)
}

function subscribe(listener: (event: IpcEventEnvelope) => void): Unsubscribe {
  if (!WINDOW_CAPABILITIES[windowKind].events) return () => undefined
  const handler = (_electronEvent: Electron.IpcRendererEvent, event: IpcEventEnvelope): void => listener(event)
  ipcRenderer.on(IPC_CHANNELS.event, handler)
  const unsubscribe = (): void => {
    ipcRenderer.off(IPC_CHANNELS.event, handler)
    subscriptions.delete(unsubscribe)
  }
  subscriptions.add(unsubscribe)
  return unsubscribe
}

const windowApi: AIMaidApi['window'] = {}
if (canRequest(windowKind, 'window.open')) windowApi.open = (target) => invoke('window.open', { target })
if (canRequest(windowKind, 'window.show')) windowApi.show = () => invoke('window.show', {})
if (canRequest(windowKind, 'window.hide')) windowApi.hide = () => invoke('window.hide', {})
if (canRequest(windowKind, 'window.close')) windowApi.close = () => invoke('window.close', {})
if (canRequest(windowKind, 'window.focus')) windowApi.focus = () => invoke('window.focus', {})

const coreApi: AIMaidApi['core'] = {}
if (canRequest(windowKind, 'core.invoke')) coreApi.invoke = (request: CoreRequest, timeoutMs?: number) => invoke('core.invoke', request, timeoutMs)
if (canRequest(windowKind, 'core.status')) coreApi.status = () => invoke<CoreStatus>('core.status', {})
if (WINDOW_CAPABILITIES[windowKind].events) coreApi.subscribe = subscribe
if (canRequest(windowKind, 'core.invoke')) coreApi.cancel = cancel

const dialogApi: AIMaidApi['dialog'] = canRequest(windowKind, 'dialog.openFile')
  ? Object.freeze({ openFile: (filters = []) => invoke('dialog.openFile', { filters }) })
  : undefined

const api: AIMaidApi = {
  windowKind,
  window: Object.freeze(windowApi),
  core: Object.freeze(coreApi),
  ...(dialogApi === undefined ? {} : { dialog: dialogApi })
}

process.once('exit', () => {
  for (const unsubscribe of [...subscriptions]) unsubscribe()
})

contextBridge.exposeInMainWorld('aimaid', Object.freeze(api))

function readWindowKind(args: string[]): WindowKind {
  const raw = args.find((argument) => argument.startsWith('--aimaid-window='))?.split('=', 2)[1]
  if (!isWindowKind(raw)) throw new Error('Missing or invalid window capability scope')
  return raw
}

function createRequestId(): string {
  return globalThis.crypto.randomUUID()
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 10_000
  return Math.min(30_000, Math.max(100, Math.trunc(timeoutMs)))
}

function forbiddenResponse<T>(type: IpcRequestType): IpcResponseEnvelope<T> {
  return {
    requestId: createRequestId(),
    type,
    payload: null,
    success: false,
    error: { code: 'IPC_FORBIDDEN', message: 'This API is not available to the current window', retryable: false },
    timestamp: Date.now()
  }
}
