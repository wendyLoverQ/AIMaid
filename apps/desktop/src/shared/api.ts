import type { CoreRequest, CoreStatus } from './core'
import type { IpcEventEnvelope, IpcResponseEnvelope } from './ipc'
import type { WindowKind } from './windows'

export type Unsubscribe = () => void

export interface AIMaidApi {
  readonly windowKind: WindowKind
  readonly window: {
    open?: (target: WindowKind) => Promise<IpcResponseEnvelope>
    show?: () => Promise<IpcResponseEnvelope>
    hide?: () => Promise<IpcResponseEnvelope>
    close?: () => Promise<IpcResponseEnvelope>
    focus?: () => Promise<IpcResponseEnvelope>
  }
  readonly core: {
    invoke?: (request: CoreRequest, timeoutMs?: number) => Promise<IpcResponseEnvelope>
    status?: () => Promise<IpcResponseEnvelope<CoreStatus>>
    subscribe?: (listener: (event: IpcEventEnvelope) => void) => Unsubscribe
    cancel?: (requestId: string) => void
  }
  readonly dialog?: {
    openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<IpcResponseEnvelope>
  }
}

declare global {
  interface Window {
    aimaid: AIMaidApi
  }
}
