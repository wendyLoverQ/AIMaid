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

const moduleCapabilities = (events = true): WindowCapabilities => ({ requests: MODULE_REQUESTS, events })

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
    requests: [...MODULE_REQUESTS, 'media.registerLocalFile', 'voice-input.consume', 'voice-input.acknowledge'],
    events: true
  },
  'voice-input': {
    requests: ['window.close', 'core.invoke', 'speech.audio.importData', 'voice-input.complete'],
    events: false
  },
  settings: {
    requests: ['window.open', 'window.show', 'window.hide', 'window.close', 'window.quit', 'window.focus',
      'window.minimize', 'window.toggleMaximize', 'core.invoke', 'core.status', 'pet.presentation.get', 'pet.presentation.execute',
      'system.settings.get', 'system.settings.setAutoStart', 'system.settings.setHotkey', 'system.settings.setBubbleStyle'],
    events: false
  },
  status: { requests: [...MODULE_REQUESTS, 'media.registerLocalFile', 'pet.runtime.get'], events: true },
  appearance: moduleCapabilities(false),
  bitcoin: moduleCapabilities(),
  timer: moduleCapabilities(),
  video: { requests: [...MODULE_REQUESTS, 'shell.showItemInFolder'], events: true },
  'remote-video': { requests: [...MODULE_REQUESTS, 'shell.showItemInFolder', 'shell.openExternal'], events: true },
  reminders: moduleCapabilities(),
  notebook: { requests: [...MODULE_REQUESTS, 'notebook.attachment.importFile', 'notebook.attachment.importData', 'notebook.attachment.action'], events: true },
  vault: moduleCapabilities(),
  scripts: moduleCapabilities(),
  'voice-conversation': { requests: [...MODULE_REQUESTS, 'media.registerLocalFile', 'speech.audio.importData'], events: true },
  characters: { requests: [...MODULE_REQUESTS, 'media.registerLocalFile', 'pet.presentation.get'], events: true },
  'crypto-events': moduleCapabilities(),
  'crypto-provider': moduleCapabilities(false),
  'crypto-chart': moduleCapabilities(),
  'video-player': { requests: [...MODULE_REQUESTS, 'media.registerLocalFile'], events: false },
  'video-subtitles': moduleCapabilities(false),
  'remote-site-config': { requests: [...MODULE_REQUESTS, 'douyin.session.inspect', 'douyin.session.clear'], events: false },
  'template-card': moduleCapabilities(false),
  'character-editor': { requests: [...MODULE_REQUESTS, 'media.registerLocalFile'], events: false },
  'agent-confirm': { requests: ['window.close', 'agent.confirmation.get', 'agent.confirmation.resolve'], events: false },
  'tray-menu': { requests: ['window.open', 'window.close', 'tray.action', 'tray.resize', 'core.invoke'], events: true },
  'douyin-login': { requests: ['window.close', 'window.minimize', 'window.toggleMaximize', 'douyin.session.save'], events: false },
  'ui-showcase': moduleCapabilities(false)
}

export function canRequest(kind: WindowKind, type: IpcRequestType): boolean {
  return WINDOW_CAPABILITIES[kind].requests.some((allowed) => allowed === type)
}
