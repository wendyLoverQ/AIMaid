import type { CoreEventType, CoreRequest, CoreStatus } from '../../shared/core'
import type { IpcEventEnvelope, IpcResponseEnvelope } from '../../shared/ipc'
import type { WindowKind } from '../../shared/windows'
import type { PetAssetManifest, PetCoordinateSnapshot, PetLifecycleEvent, PetPerformanceMetrics, PetRectangle, PetRuntimeSnapshot, PetWindowUpdate } from '../../shared/pet'
import type { PetPresentationAction, PetPresentationSnapshot } from '../../shared/presentation'
import type { HotkeyAction, PlatformSettingsSnapshot } from '../../shared/system-settings'

export class BridgeCapabilityError extends Error {
  constructor(capability: string) {
    super(`当前窗口不具备 ${capability} 能力`)
    this.name = 'BridgeCapabilityError'
  }
}

export const bridge = Object.freeze({
  app: Object.freeze({
    get version(): string { return window.aimaid.appVersion }
  }),
  window: Object.freeze({
    get kind(): WindowKind {
      return window.aimaid.windowKind
    },
    open: (target: WindowKind): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.open, 'window.open')(target),
    show: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.show, 'window.show')(),
    hide: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.hide, 'window.hide')(),
    close: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.close, 'window.close')(),
    quit: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.quit, 'window.quit')(),
    focus: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.focus, 'window.focus')(),
    minimize: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.window.minimize, 'window.minimize')(),
    toggleMaximize: (): Promise<IpcResponseEnvelope<{ maximized: boolean }>> =>
      requireCapability(window.aimaid.window.toggleMaximize, 'window.toggleMaximize')()
  }),
  core: Object.freeze({
    invoke: (request: CoreRequest, timeoutMs?: number, requestId?: string): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.core.invoke, 'core.invoke')(request, timeoutMs, requestId),
    status: (): Promise<IpcResponseEnvelope<CoreStatus>> => requireCapability(window.aimaid.core.status, 'core.status')(),
    restart: (): Promise<IpcResponseEnvelope<CoreStatus>> => requireCapability(window.aimaid.core.restart, 'core.restart')(),
    cancel: (requestId: string): void => requireCapability(window.aimaid.core.cancel, 'core.cancel')(requestId)
  }),
  agentConfirmation: Object.freeze({
    get: () => requireCapability(window.aimaid.agentConfirmation?.get, 'agent.confirmation.get')(),
    resolve: (requestId: string, approved: boolean) => requireCapability(window.aimaid.agentConfirmation?.resolve, 'agent.confirmation.resolve')(requestId, approved)
  }),
  systemSettings: Object.freeze({
    get: (): Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>> =>
      requireCapability(window.aimaid.systemSettings?.get, 'system.settings.get')(),
    setAutoStart: (enabled: boolean): Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>> =>
      requireCapability(window.aimaid.systemSettings?.setAutoStart, 'system.settings.setAutoStart')(enabled),
    setHotkey: (action: HotkeyAction, gesture: string): Promise<IpcResponseEnvelope<PlatformSettingsSnapshot>> =>
      requireCapability(window.aimaid.systemSettings?.setHotkey, 'system.settings.setHotkey')(action, gesture),
    setBubbleStyle: (style: string): Promise<IpcResponseEnvelope<{ style: string }>> =>
      requireCapability(window.aimaid.systemSettings?.setBubbleStyle, 'system.settings.setBubbleStyle')(style)
  }),
  events: Object.freeze({
    subscribe: (types: CoreEventType[], listener: (event: IpcEventEnvelope) => void): (() => void) =>
      requireCapability(window.aimaid.core.subscribe, 'events.subscribe')(types, listener)
  }),
  pet: Object.freeze({
    ready: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.pet?.ready, 'pet.ready')(),
    getAssetManifest: (modelId: string): Promise<IpcResponseEnvelope<PetAssetManifest>> =>
      requireCapability(window.aimaid.pet?.getAssetManifest, 'pet.getAssetManifest')(modelId),
    setIgnoreMouseEvents: (ignore: boolean): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.pet?.setIgnoreMouseEvents, 'pet.setIgnoreMouseEvents')(ignore),
    dragStart: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.pet?.dragStart, 'pet.dragStart')(),
    dragMove: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.pet?.dragMove, 'pet.dragMove')(),
    dragEnd: (): Promise<IpcResponseEnvelope> => requireCapability(window.aimaid.pet?.dragEnd, 'pet.dragEnd')(),
    updateWindow: (update: PetWindowUpdate): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.pet?.updateWindow, 'pet.updateWindow')(update),
    captureCoordinates: (bounds: PetRectangle): Promise<IpcResponseEnvelope<PetCoordinateSnapshot>> =>
      requireCapability(window.aimaid.pet?.captureCoordinates, 'pet.captureCoordinates')(bounds),
    reportMetrics: (metrics: PetPerformanceMetrics): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.pet?.reportMetrics, 'pet.reportMetrics')(metrics),
    runtimeStatus: (): Promise<IpcResponseEnvelope<PetRuntimeSnapshot>> =>
      requireCapability(window.aimaid.pet?.runtimeStatus, 'pet.runtime.get')(),
    presentation: Object.freeze({
      get: (): Promise<IpcResponseEnvelope<PetPresentationSnapshot>> =>
        requireCapability(window.aimaid.pet?.presentation.get, 'pet.presentation.get')(),
      execute: (action: PetPresentationAction): Promise<IpcResponseEnvelope<PetPresentationSnapshot>> =>
        requireCapability(window.aimaid.pet?.presentation.execute, 'pet.presentation.execute')(action)
    }),
    onLifecycle: (listener: (event: PetLifecycleEvent) => void): (() => void) =>
      requireCapability(window.aimaid.pet?.onLifecycle, 'pet.onLifecycle')(listener)
  }),
  dialog: Object.freeze({
    openFile: (filters?: Array<{ name: string; extensions: string[] }>, multiSelect = false): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.dialog?.openFile, 'dialog.openFile')(filters, multiSelect),
    openDirectory: (): Promise<IpcResponseEnvelope<{ canceled: boolean; filePaths: string[] }>> =>
      requireCapability(window.aimaid.dialog?.openDirectory, 'dialog.openDirectory')(),
    saveFile: (defaultPath: string, filters?: Array<{ name: string; extensions: string[] }>): Promise<IpcResponseEnvelope<{ canceled: boolean; filePath?: string }>> =>
      requireCapability(window.aimaid.dialog?.saveFile, 'dialog.saveFile')(defaultPath, filters)
  }),
  shell: Object.freeze({
    showItemInFolder: (filePath: string): Promise<IpcResponseEnvelope<{ shown: boolean }>> =>
      requireCapability(window.aimaid.shell?.showItemInFolder, 'shell.showItemInFolder')(filePath),
    openExternal: (url: string): Promise<IpcResponseEnvelope<{ opened: boolean }>> =>
      requireCapability(window.aimaid.shell?.openExternal, 'shell.openExternal')(url)
  }),
  media: Object.freeze({
    registerLocalFile: (filePath: string): Promise<IpcResponseEnvelope<{ url: string }>> =>
      requireCapability(window.aimaid.media?.registerLocalFile, 'media.registerLocalFile')(filePath)
  }),
  notebook: Object.freeze({
    importFile: (filePath: string): Promise<IpcResponseEnvelope<{ path: string; url: string; name: string }>> =>
      requireCapability(window.aimaid.notebook?.importFile, 'notebook.importFile')(filePath),
    importData: (name: string, dataUrl: string): Promise<IpcResponseEnvelope<{ path: string; url: string; name: string }>> =>
      requireCapability(window.aimaid.notebook?.importData, 'notebook.importData')(name, dataUrl),
    imageAction: (action: 'copy' | 'openLocation' | 'saveAs', path: string): Promise<IpcResponseEnvelope<{ action: string }>> =>
      requireCapability(window.aimaid.notebook?.imageAction, 'notebook.imageAction')(action, path)
  }),
  speech: Object.freeze({
    importAudioData: (dataUrl: string): Promise<IpcResponseEnvelope<{ path: string }>> =>
      requireCapability(window.aimaid.speech?.importAudioData, 'speech.audio.importData')(dataUrl)
  }),
  tray: Object.freeze({
    action: (action: 'show' | 'reset-position' | 'hide' | 'quit'): Promise<IpcResponseEnvelope> =>
      requireCapability(window.aimaid.tray?.action, 'tray.action')(action),
    resize: (height: number): Promise<IpcResponseEnvelope<{ height: number }>> =>
      requireCapability(window.aimaid.tray?.resize, 'tray.resize')(height)
  }),
  douyin: Object.freeze({
    saveSession: (): Promise<IpcResponseEnvelope<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>> =>
      requireCapability(window.aimaid.douyin?.saveSession, 'douyin.session.save')(),
    inspectSession: (): Promise<IpcResponseEnvelope<{ cookieCount: number; hasSession: boolean; hasTtwid: boolean; hasMsToken: boolean; savedAt: string }>> =>
      requireCapability(window.aimaid.douyin?.inspectSession, 'douyin.session.inspect')(),
    clearSession: (): Promise<IpcResponseEnvelope<{ cleared: boolean }>> =>
      requireCapability(window.aimaid.douyin?.clearSession, 'douyin.session.clear')()
  })
})

function requireCapability<T extends (...args: never[]) => unknown>(capability: T | undefined, name: string): T {
  if (capability === undefined) throw new BridgeCapabilityError(name)
  return capability
}
