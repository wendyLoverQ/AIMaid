import type { CoreEventType } from './core'

export const IPC_CHANNELS = {
  invoke: 'aimaid:invoke',
  send: 'aimaid:send',
  event: 'aimaid:event',
  petLifecycle: 'aimaid:pet-lifecycle',
  petLipSync: 'aimaid:pet-lip-sync'
} as const

export const IPC_REQUEST_TYPES = [
  'window.open',
  'window.show',
  'window.hide',
  'window.close',
  'window.quit',
  'window.focus',
  'window.minimize',
  'window.toggleMaximize',
  'dialog.openFile',
  'dialog.openDirectory',
  'dialog.saveFile',
  'shell.showItemInFolder',
  'shell.openExternal',
  'media.registerLocalFile',
  'notebook.attachment.importFile',
  'notebook.attachment.importData',
  'notebook.attachment.action',
  'speech.audio.importData',
  'tray.action',
  'tray.resize',
  'douyin.session.save',
  'douyin.session.inspect',
  'douyin.session.clear',
  'agent.confirmation.get',
  'agent.confirmation.resolve',
  'core.invoke',
  'core.status',
  'core.restart',
  'pet.ready',
  'pet.getAssetManifest',
  'pet.setIgnoreMouseEvents',
  'pet.dragStart',
  'pet.dragMove',
  'pet.dragEnd',
  'pet.updateWindow',
  'pet.reportMetrics',
  'pet.runtime.get',
  'pet.presentation.get',
  'pet.presentation.execute'
  ,'system.settings.get'
  ,'system.settings.setAutoStart'
  ,'system.settings.setHotkey'
  ,'system.settings.setBubbleStyle'
] as const

export type IpcRequestType = (typeof IPC_REQUEST_TYPES)[number]
export type IpcNotificationType = 'request.cancel' | 'event.subscribe' | 'event.unsubscribe' | 'pet.lipSync.sample'

export interface IpcError {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface IpcRequestEnvelope {
  requestId: string
  type: IpcRequestType
  payload: unknown
  timestamp: number
}

export interface IpcNotificationEnvelope {
  requestId: string
  type: IpcNotificationType
  payload: unknown
  timestamp: number
}

export interface IpcResponseEnvelope<T = unknown> {
  requestId: string
  type: IpcRequestType
  payload: T | null
  success: boolean
  error: IpcError | null
  timestamp: number
}

export interface IpcEventEnvelope<T = unknown> {
  requestId: string
  type: CoreEventType
  payload: T
  success: true
  error: null
  timestamp: number
}

export function isIpcRequestEnvelope(value: unknown): value is IpcRequestEnvelope {
  if (!isRecord(value)) return false
  return (
    typeof value.requestId === 'string' &&
    value.requestId.length >= 8 &&
    value.requestId.length <= 100 &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    typeof value.type === 'string' &&
    IPC_REQUEST_TYPES.some((type) => type === value.type) &&
    'payload' in value
  )
}

export function isIpcNotificationEnvelope(value: unknown): value is IpcNotificationEnvelope {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    (value.type === 'request.cancel' || value.type === 'event.subscribe' || value.type === 'event.unsubscribe' || value.type === 'pet.lipSync.sample') &&
    typeof value.timestamp === 'number'
  )
}

export function successResponse<T>(request: IpcRequestEnvelope, payload: T): IpcResponseEnvelope<T> {
  return {
    requestId: request.requestId,
    type: request.type,
    payload,
    success: true,
    error: null,
    timestamp: Date.now()
  }
}

export function errorResponse(request: IpcRequestEnvelope, error: IpcError): IpcResponseEnvelope {
  return {
    requestId: request.requestId,
    type: request.type,
    payload: null,
    success: false,
    error,
    timestamp: Date.now()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
