import type { IpcRequestType } from './ipc'
import type { WindowKind } from './windows'

export interface WindowCapabilities {
  requests: readonly IpcRequestType[]
  events: boolean
}

const MODULE_REQUESTS: readonly IpcRequestType[] = [
  'window.open', 'window.show', 'window.hide', 'window.close', 'window.quit', 'window.focus',
  'window.minimize', 'window.toggleMaximize', 'dialog.openFile', 'dialog.openDirectory', 'dialog.saveFile', 'core.invoke', 'core.status'
]
const NORMAL_MODULE_REQUESTS: readonly IpcRequestType[] = [...MODULE_REQUESTS, 'window.setBackgroundColor']

const moduleCapabilities = (events = true): WindowCapabilities => ({ requests: NORMAL_MODULE_REQUESTS, events })

export const WINDOW_CAPABILITIES: Readonly<Record<WindowKind, WindowCapabilities>> = {
  main: {
    requests: [
      'window.open',
      'window.show',
      'window.hide',
      'window.close',
      'window.quit',
      'window.focus',
      'window.minimize',
      'window.toggleMaximize',
      'window.setBackgroundColor',
      'dialog.openFile',
      'dialog.openDirectory',
      'dialog.saveFile',
      'core.invoke',
      'core.status',
      'core.restart'
    ],
    events: true
  },
  pet: {
    requests: [
      'window.open', 'window.show', 'window.hide', 'window.close', 'window.quit', 'window.focus', 'core.invoke', 'core.status',
      'pet.ready', 'pet.getAssetManifest', 'pet.setIgnoreMouseEvents',
      'pet.dragStart', 'pet.dragMove', 'pet.dragEnd', 'pet.updateWindow',
      'pet.reportMetrics',
      'pet.presentation.get', 'pet.presentation.execute', 'media.registerLocalFile'
    ],
    events: true
  },
  chat: {
    requests: [...MODULE_REQUESTS, 'media.registerLocalFile', 'speech.audio.importData'],
    events: true
  },
  settings: {
    requests: ['window.open', 'window.show', 'window.hide', 'window.close', 'window.quit', 'window.focus',
      'window.minimize', 'window.toggleMaximize', 'window.setBackgroundColor', 'core.invoke', 'core.status', 'pet.presentation.get', 'pet.presentation.execute',
      'system.settings.get', 'system.settings.setAutoStart', 'system.settings.setHotkey', 'system.settings.setBubbleStyle'],
    events: false
  },
  status: { requests: [...NORMAL_MODULE_REQUESTS, 'media.registerLocalFile', 'pet.runtime.get'], events: true },
  appearance: moduleCapabilities(false),
  bitcoin: moduleCapabilities(),
  timer: { requests: MODULE_REQUESTS, events: true },
  video: { requests: [...NORMAL_MODULE_REQUESTS, 'shell.showItemInFolder'], events: true },
  'remote-video': { requests: [...NORMAL_MODULE_REQUESTS, 'shell.showItemInFolder', 'shell.openExternal'], events: true },
  reminders: moduleCapabilities(),
  notebook: { requests: [...NORMAL_MODULE_REQUESTS, 'notebook.attachment.importFile', 'notebook.attachment.importData', 'notebook.attachment.action'], events: true },
  vault: moduleCapabilities(),
  scripts: moduleCapabilities(),
  'voice-conversation': { requests: [...NORMAL_MODULE_REQUESTS, 'media.registerLocalFile', 'speech.audio.importData'], events: true },
  characters: { requests: [...NORMAL_MODULE_REQUESTS, 'media.registerLocalFile', 'pet.presentation.get'], events: true },
  'crypto-events': moduleCapabilities(),
  'crypto-provider': moduleCapabilities(false),
  'crypto-chart': moduleCapabilities(),
  'video-player': { requests: [...NORMAL_MODULE_REQUESTS, 'media.registerLocalFile'], events: false },
  'video-subtitles': moduleCapabilities(false),
  'remote-site-config': { requests: [...NORMAL_MODULE_REQUESTS, 'douyin.session.inspect', 'douyin.session.clear'], events: false },
  'template-card': moduleCapabilities(false),
  'character-editor': { requests: [...NORMAL_MODULE_REQUESTS, 'media.registerLocalFile'], events: false },
  'agent-confirm': { requests: ['window.close', 'agent.confirmation.get', 'agent.confirmation.resolve'], events: false },
  'tray-menu': { requests: ['window.open', 'window.close', 'tray.action', 'tray.resize', 'core.invoke', 'core.status'], events: true },
  'douyin-login': { requests: ['window.close', 'window.minimize', 'window.toggleMaximize', 'douyin.session.save'], events: false },
  'ui-showcase': moduleCapabilities(false)
}

export function canRequest(kind: WindowKind, type: IpcRequestType): boolean {
  return WINDOW_CAPABILITIES[kind].requests.some((allowed) => allowed === type)
}
