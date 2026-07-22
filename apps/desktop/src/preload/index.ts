import { contextBridge, ipcRenderer } from 'electron'
import type { AIMaidApi, Unsubscribe } from '../shared/api'
import { WINDOW_CAPABILITIES, canRequest } from '../shared/capabilities'
import { coreRequestTimeoutMs, isCoreEventType } from '../shared/core'
import type { CoreEventType, CoreRequest, CoreStatus } from '../shared/core'
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
import type { PetAssetManifest, PetLifecycleEvent, PetPerformanceMetrics, PetRuntimeSnapshot, PetWindowUpdate } from '../shared/pet'
import type { PetPresentationAction, PetPresentationSnapshot } from '../shared/presentation'
import type { AgentConfirmationRequest } from '../shared/business'
import type { HotkeyAction, PlatformSettingsSnapshot } from '../shared/system-settings'

const windowKind = readWindowKind(process.argv)
const appVersion = readArgument(process.argv, '--aimaid-version=') ?? '0.0.0'
const subscriptions = new Set<Unsubscribe>()

function invoke<T = unknown>(type: IpcRequestType, payload: unknown, timeoutMs = 10_000, providedRequestId?: string): Promise<IpcResponseEnvelope<T>> {
  if (!canRequest(windowKind, type)) return Promise.resolve(forbiddenResponse<T>(type))
  const request: IpcRequestEnvelope = { requestId: providedRequestId ?? createRequestId(), type, payload, timestamp: Date.now() }
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
  sendNotification(requestId, 'request.cancel', null)
}

function sendNotification(requestId: string, type: IpcNotificationEnvelope['type'], payload: unknown): void {
  const notification: IpcNotificationEnvelope = { requestId, type, payload, timestamp: Date.now() }
  ipcRenderer.send(IPC_CHANNELS.send, notification)
}

function subscribe(types: CoreEventType[], listener: (event: IpcEventEnvelope) => void): Unsubscribe {
  if (!WINDOW_CAPABILITIES[windowKind].events) return () => undefined
  if (types.length === 0 || types.length > 20 || !types.every(isCoreEventType)) throw new TypeError('Invalid event subscription')
  const subscriptionId = createRequestId()
  const allowed = new Set(types)
  const handler = (_electronEvent: Electron.IpcRendererEvent, event: IpcEventEnvelope): void => {
    if (allowed.has(event.type)) listener(event)
  }
  ipcRenderer.on(IPC_CHANNELS.event, handler)
  sendNotification(subscriptionId, 'event.subscribe', { types })
  const unsubscribe = (): void => {
    ipcRenderer.off(IPC_CHANNELS.event, handler)
    sendNotification(subscriptionId, 'event.unsubscribe', {})
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
if (canRequest(windowKind, 'window.quit')) windowApi.quit = () => invoke('window.quit', {})
if (canRequest(windowKind, 'window.focus')) windowApi.focus = () => invoke('window.focus', {})
if (canRequest(windowKind, 'window.minimize')) windowApi.minimize = () => invoke('window.minimize', {})
if (canRequest(windowKind, 'window.toggleMaximize')) {
  windowApi.toggleMaximize = () => invoke<{ maximized: boolean }>('window.toggleMaximize', {})
}

const coreApi: AIMaidApi['core'] = {}
if (canRequest(windowKind, 'core.invoke')) coreApi.invoke = (request: CoreRequest, timeoutMs?: number, requestId?: string) =>
  invoke('core.invoke', request, timeoutMs ?? coreRequestTimeoutMs(request.type), requestId)
if (canRequest(windowKind, 'core.status')) coreApi.status = () => invoke<CoreStatus>('core.status', {})
if (canRequest(windowKind, 'core.restart')) coreApi.restart = () => invoke<CoreStatus>('core.restart', {}, 30_000)
if (WINDOW_CAPABILITIES[windowKind].events) coreApi.subscribe = subscribe
if (canRequest(windowKind, 'core.invoke')) coreApi.cancel = cancel

const systemSettingsApi: AIMaidApi['systemSettings'] = canRequest(windowKind, 'system.settings.get')
  ? Object.freeze({
      get: () => invoke<PlatformSettingsSnapshot>('system.settings.get', {}),
      setAutoStart: (enabled: boolean) => invoke<PlatformSettingsSnapshot>('system.settings.setAutoStart', { enabled }),
      setHotkey: (action: HotkeyAction, gesture: string) => invoke<PlatformSettingsSnapshot>('system.settings.setHotkey', { action, gesture })
      ,setBubbleStyle: (style: string) => invoke<{ style: string }>('system.settings.setBubbleStyle', { style })
    })
  : undefined

const dialogApi: AIMaidApi['dialog'] = canRequest(windowKind, 'dialog.openFile') || canRequest(windowKind, 'dialog.openDirectory') || canRequest(windowKind, 'dialog.saveFile')
  ? Object.freeze({
      openFile: (filters = [], multiSelect = false) => invoke('dialog.openFile', { filters, multiSelect }),
      openDirectory: () => invoke<{ canceled: boolean; filePaths: string[] }>('dialog.openDirectory', {}),
      saveFile: (defaultPath, filters = []) => invoke<{ canceled: boolean; filePath?: string }>('dialog.saveFile', { defaultPath, filters })
    })
  : undefined
const shellApi: AIMaidApi['shell'] = canRequest(windowKind, 'shell.showItemInFolder') || canRequest(windowKind, 'shell.openExternal')
  ? Object.freeze({
      showItemInFolder: (filePath: string) => invoke<{ shown: boolean }>('shell.showItemInFolder', { filePath }),
      openExternal: (url: string) => invoke<{ opened: boolean }>('shell.openExternal', { url })
    })
  : undefined
const mediaApi: AIMaidApi['media'] = canRequest(windowKind, 'media.registerLocalFile')
  ? Object.freeze({ registerLocalFile: (filePath: string) => invoke<{ url: string }>('media.registerLocalFile', { filePath }) })
  : undefined
const notebookApi: AIMaidApi['notebook'] = canRequest(windowKind, 'notebook.attachment.importFile')
  ? Object.freeze({
      importFile: (filePath: string) => invoke<{ path: string; url: string; name: string }>('notebook.attachment.importFile', { filePath }),
      importData: (name: string, dataUrl: string) => invoke<{ path: string; url: string; name: string }>('notebook.attachment.importData', { name, dataUrl }, 30_000),
      imageAction: (action: 'copy' | 'openLocation' | 'saveAs', path: string) => invoke<{ action: string }>('notebook.attachment.action', { action, path })
    })
  : undefined
const speechApi: AIMaidApi['speech'] = canRequest(windowKind, 'speech.audio.importData')
  ? Object.freeze({ importAudioData: (dataUrl: string) => invoke<{ path: string }>('speech.audio.importData', { dataUrl }, 30_000) })
  : undefined

const trayApi: AIMaidApi['tray'] = canRequest(windowKind, 'tray.action')
  ? Object.freeze({
      action: (action) => invoke('tray.action', { action }),
      resize: (height) => invoke<{ height: number }>('tray.resize', { height })
    })
  : undefined
const douyinApi: AIMaidApi['douyin'] = canRequest(windowKind, 'douyin.session.save') || canRequest(windowKind, 'douyin.session.inspect') || canRequest(windowKind, 'douyin.session.clear')
  ? Object.freeze({
      saveSession: () => invoke<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>('douyin.session.save', {}),
      inspectSession: () => invoke<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>('douyin.session.inspect', {}),
      clearSession: () => invoke<{ cleared: boolean }>('douyin.session.clear', {})
    })
  : undefined
const agentConfirmationApi: AIMaidApi['agentConfirmation'] = canRequest(windowKind, 'agent.confirmation.get')
  ? Object.freeze({
      get: () => invoke<AgentConfirmationRequest | null>('agent.confirmation.get', {}),
      resolve: (requestId: string, approved: boolean) => invoke<{ resolved: boolean }>('agent.confirmation.resolve', { requestId, approved })
    })
  : undefined

const petApi: AIMaidApi['pet'] = windowKind === 'pet' || canRequest(windowKind, 'pet.presentation.get') || canRequest(windowKind, 'pet.runtime.get')
  ? Object.freeze({
      ready: () => invoke('pet.ready', {}),
      getAssetManifest: (modelId: string) => invoke<PetAssetManifest>('pet.getAssetManifest', { modelId }),
      setIgnoreMouseEvents: (ignore: boolean) => invoke('pet.setIgnoreMouseEvents', { ignore }),
      dragStart: () => invoke('pet.dragStart', {}),
      dragMove: () => invoke('pet.dragMove', {}),
      dragEnd: () => invoke('pet.dragEnd', {}),
      updateWindow: (update: PetWindowUpdate) => invoke('pet.updateWindow', update),
      reportMetrics: (metrics: PetPerformanceMetrics) => invoke('pet.reportMetrics', metrics),
      runtimeStatus: () => invoke<PetRuntimeSnapshot>('pet.runtime.get', {}),
      presentation: Object.freeze({
        get: () => invoke<PetPresentationSnapshot>('pet.presentation.get', {}),
        execute: (action: PetPresentationAction) => invoke<PetPresentationSnapshot>('pet.presentation.execute', { action })
      }),
      onLifecycle: (listener: (event: PetLifecycleEvent) => void): Unsubscribe => {
        const handler = (_event: Electron.IpcRendererEvent, payload: PetLifecycleEvent): void => listener(payload)
        ipcRenderer.on(IPC_CHANNELS.petLifecycle, handler)
        const unsubscribe = (): void => {
          ipcRenderer.off(IPC_CHANNELS.petLifecycle, handler)
          subscriptions.delete(unsubscribe)
        }
        subscriptions.add(unsubscribe)
        return unsubscribe
      }
    })
  : undefined

const api: AIMaidApi = {
  appVersion,
  windowKind,
  window: Object.freeze(windowApi),
  core: Object.freeze(coreApi),
  ...(systemSettingsApi === undefined ? {} : { systemSettings: systemSettingsApi }),
  ...(dialogApi === undefined ? {} : { dialog: dialogApi }),
  ...(shellApi === undefined ? {} : { shell: shellApi }),
  ...(mediaApi === undefined ? {} : { media: mediaApi }),
  ...(notebookApi === undefined ? {} : { notebook: notebookApi }),
  ...(speechApi === undefined ? {} : { speech: speechApi }),
  ...(trayApi === undefined ? {} : { tray: trayApi }),
  ...(douyinApi === undefined ? {} : { douyin: douyinApi }),
  ...(agentConfirmationApi === undefined ? {} : { agentConfirmation: agentConfirmationApi }),
  ...(petApi === undefined ? {} : { pet: petApi })
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

function readArgument(args: string[], prefix: string): string | undefined {
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length)
}

function createRequestId(): string {
  return globalThis.crypto.randomUUID()
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 10_000
  return Math.min(120_000, Math.max(100, Math.trunc(timeoutMs)))
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
