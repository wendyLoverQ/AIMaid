import type { BrowserWindowConstructorOptions } from 'electron'
import type { WindowKind } from '../../shared/windows'

export interface WindowDefinition {
  id: WindowKind
  route: WindowKind
  closeBehavior: 'destroy' | 'hide'
  options: BrowserWindowConstructorOptions
}

export const WINDOW_REGISTRY: Readonly<Record<WindowKind, WindowDefinition>> = {
  main: {
    id: 'main',
    route: 'main',
    closeBehavior: 'destroy',
    options: { width: 1280, height: 820, minWidth: 960, minHeight: 680, frame: false, resizable: true, show: false }
  },
  pet: {
    id: 'pet',
    route: 'pet',
    closeBehavior: 'hide',
    options: {
      width: 560,
      height: 980,
      minWidth: 160,
      minHeight: 160,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      maximizable: false,
      fullscreenable: false,
      show: false
    }
  },
  chat: {
    id: 'chat',
    route: 'chat',
    closeBehavior: 'hide',
    options: {
      width: 400,
      height: 200,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      show: false
    }
  },
  settings: {
    id: 'settings',
    route: 'settings',
    closeBehavior: 'hide',
    options: { width: 820, height: 680, minWidth: 720, minHeight: 560, frame: false, resizable: true, show: false }
  },
  status: moduleWindow('status', 1280, 820, 960, 680),
  appearance: moduleWindow('appearance', 1040, 920, 460, 760),
  bitcoin: moduleWindow('bitcoin', 1120, 640, 840, 520),
  timer: {
    id: 'timer', route: 'timer', closeBehavior: 'hide',
    options: {
      width: 560, height: 680, minWidth: 520, minHeight: 620, transparent: true,
      backgroundColor: '#00000000', frame: false, resizable: true, show: false
    }
  },
  video: moduleWindow('video', 1760, 940, 1200, 720),
  'remote-video': moduleWindow('remote-video', 1260, 840, 1040, 720),
  reminders: moduleWindow('reminders', 760, 560, 680, 500),
  notebook: moduleWindow('notebook', 980, 680, 920, 520),
  vault: moduleWindow('vault', 1220, 760, 980, 620),
  scripts: moduleWindow('scripts', 980, 680, 820, 560),
  'voice-conversation': moduleWindow('voice-conversation', 1260, 840, 1040, 720),
  characters: moduleWindow('characters', 1160, 800, 1120, 680),
  'crypto-events': moduleWindow('crypto-events', 920, 640, 720, 480),
  'crypto-provider': moduleWindow('crypto-provider', 640, 520, 520, 420),
  'crypto-chart': moduleWindow('crypto-chart', 1120, 720, 720, 480),
  'video-player': moduleWindow('video-player', 720, 480, 480, 420),
  'video-subtitles': moduleWindow('video-subtitles', 720, 520, 560, 420),
  'remote-site-config': moduleWindow('remote-site-config', 1100, 760, 980, 680),
  'template-card': moduleWindow('template-card', 820, 680, 720, 560),
  'character-editor': moduleWindow('character-editor', 920, 720, 820, 620),
  'agent-confirm': {
    id: 'agent-confirm', route: 'agent-confirm', closeBehavior: 'hide',
    options: { width: 480, height: 420, frame: false, resizable: false, modal: false, show: false }
  },
  'tray-menu': {
    id: 'tray-menu', route: 'tray-menu', closeBehavior: 'hide',
    options: {
      width: 240, height: 480, transparent: true, backgroundColor: '#00000000', frame: false,
      resizable: false, skipTaskbar: true, alwaysOnTop: true, maximizable: false, fullscreenable: false,
      show: false, focusable: true
    }
  },
  'douyin-login': moduleWindow('douyin-login', 1180, 820, 920, 680),
  'ui-showcase': moduleWindow('ui-showcase', 1180, 820, 900, 640)
}

function moduleWindow(id: WindowKind, width: number, height: number, minWidth: number, minHeight: number): WindowDefinition {
  return { id, route: id, closeBehavior: 'hide', options: { width, height, minWidth, minHeight, frame: false, resizable: true, show: false } }
}
