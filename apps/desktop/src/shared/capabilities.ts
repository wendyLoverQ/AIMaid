import type { IpcRequestType } from './ipc'
import type { WindowKind } from './windows'

export interface WindowCapabilities {
  requests: readonly IpcRequestType[]
  events: boolean
}

export const WINDOW_CAPABILITIES: Readonly<Record<WindowKind, WindowCapabilities>> = {
  main: {
    requests: [
      'window.open',
      'window.show',
      'window.hide',
      'window.close',
      'window.focus',
      'dialog.openFile',
      'core.invoke',
      'core.status'
    ],
    events: true
  },
  pet: {
    requests: ['window.show', 'window.hide', 'window.close', 'window.focus', 'core.status'],
    events: true
  },
  chat: {
    requests: ['window.show', 'window.hide', 'window.close', 'window.focus', 'core.invoke', 'core.status'],
    events: true
  },
  settings: {
    requests: ['window.show', 'window.hide', 'window.close', 'window.focus', 'dialog.openFile', 'core.invoke', 'core.status'],
    events: false
  }
}

export function canRequest(kind: WindowKind, type: IpcRequestType): boolean {
  return WINDOW_CAPABILITIES[kind].requests.some((allowed) => allowed === type)
}
