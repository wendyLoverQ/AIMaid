import type { CoreEventType, CoreRequest, CoreStatus } from './core'
import type { IpcEventEnvelope, IpcResponseEnvelope } from './ipc'
import type { PetAssetManifest, PetLifecycleEvent, PetPerformanceMetrics, PetRuntimeSnapshot, PetVisualBounds, PetWindowUpdate } from './pet'
import type { PetPresentationApi } from './presentation'
import type { WindowKind } from './windows'
import type { HotkeyAction, PlatformSettingsSnapshot } from './system-settings'
import type { AgentConfirmationRequest } from './business'

export type Unsubscribe = () => void

export interface AIMaidApi {
  readonly appVersion: string
  readonly windowKind: WindowKind
  readonly window: {
    open?: (target: WindowKind) => Promise<IpcResponseEnvelope>
    show?: () => Promise<IpcResponseEnvelope>
    hide?: () => Promise<IpcResponseEnvelope>
    close?: () => Promise<IpcResponseEnvelope>
    quit?: () => Promise<IpcResponseEnvelope>
    focus?: () => Promise<IpcResponseEnvelope>
    minimize?: () => Promise<IpcResponseEnvelope>
    toggleMaximize?: () => Promise<IpcResponseEnvelope<{ maximized: boolean }>>
  }
  readonly core: {
    invoke?: (request: CoreRequest, timeoutMs?: number, requestId?: string) => Promise<IpcResponseEnvelope>
    status?: () => Promise<IpcResponseEnvelope<CoreStatus>>
    restart?: () => Promise<IpcResponseEnvelope<CoreStatus>>
    subscribe?: (types: CoreEventType[], listener: (event: IpcEventEnvelope) => void) => Unsubscribe
    cancel?: (requestId: string) => void
  }
  readonly agentConfirmation?: {
    get: () => Promise<IpcResponseEnvelope<AgentConfirmationRequest | null>>
    resolve: (requestId: string, approved: boolean) => Promise<IpcResponseEnvelope<{ resolved: boolean }>>
  }
  readonly systemSettings?: {
    get: () => Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>>
    setAutoStart: (enabled: boolean) => Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>>
    setHotkey: (action: HotkeyAction, gesture: string) => Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>>
    setBubbleStyle: (style: string) => Promise<IpcResponseEnvelope<{ style: string }>>
  }
  readonly pet?: {
    ready: () => Promise<IpcResponseEnvelope>
    getAssetManifest: (modelId: string) => Promise<IpcResponseEnvelope<PetAssetManifest>>
    setIgnoreMouseEvents: (ignore: boolean) => Promise<IpcResponseEnvelope>
    dragStart: () => Promise<IpcResponseEnvelope>
    dragMove: () => Promise<IpcResponseEnvelope>
    dragEnd: () => Promise<IpcResponseEnvelope>
    updateWindow: (update: PetWindowUpdate) => Promise<IpcResponseEnvelope>
    reportVisualBounds: (bounds: PetVisualBounds) => Promise<IpcResponseEnvelope>
    reportMetrics: (metrics: PetPerformanceMetrics) => Promise<IpcResponseEnvelope>
    runtimeStatus: () => Promise<IpcResponseEnvelope<PetRuntimeSnapshot>>
    onLifecycle: (listener: (event: PetLifecycleEvent) => void) => Unsubscribe
    presentation: PetPresentationApi
  }
  readonly dialog?: {
    openFile: (filters?: Array<{ name: string; extensions: string[] }>, multiSelect?: boolean) => Promise<IpcResponseEnvelope>
    openDirectory: () => Promise<IpcResponseEnvelope<{ canceled: boolean; filePaths: string[] }>>
    saveFile: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>) => Promise<IpcResponseEnvelope<{ canceled: boolean; filePath?: string }>>
  }
  readonly shell?: {
    showItemInFolder: (filePath: string) => Promise<IpcResponseEnvelope<{ shown: boolean }>>
    openExternal: (url: string) => Promise<IpcResponseEnvelope<{ opened: boolean }>>
  }
  readonly media?: {
    registerLocalFile: (filePath: string) => Promise<IpcResponseEnvelope<{ url: string }>>
  }
  readonly notebook?: {
    importFile: (filePath: string) => Promise<IpcResponseEnvelope<{ path: string; url: string; name: string }>>
    importData: (name: string, dataUrl: string) => Promise<IpcResponseEnvelope<{ path: string; url: string; name: string }>>
    imageAction: (action: 'copy' | 'openLocation' | 'saveAs', path: string) => Promise<IpcResponseEnvelope<{ action: string }>>
  }
  readonly speech?: {
    importAudioData: (dataUrl: string) => Promise<IpcResponseEnvelope<{ path: string }>>
  }
  readonly tray?: {
    action: (action: 'show' | 'reset-position' | 'hide' | 'quit') => Promise<IpcResponseEnvelope>
  }
  readonly douyin?: {
    saveSession: () => Promise<IpcResponseEnvelope<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>>
    inspectSession: () => Promise<IpcResponseEnvelope<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>>
    clearSession: () => Promise<IpcResponseEnvelope<{ cleared: boolean }>>
  }
}

declare global {
  interface Window {
    aimaid: AIMaidApi
  }
}
