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
    options: { width: 980, height: 680, minWidth: 720, minHeight: 520, resizable: true, show: false }
  },
  pet: {
    id: 'pet',
    route: 'pet',
    closeBehavior: 'hide',
    options: {
      width: 360,
      height: 520,
      minWidth: 240,
      minHeight: 320,
      transparent: true,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false
    }
  },
  chat: {
    id: 'chat',
    route: 'chat',
    closeBehavior: 'hide',
    options: { width: 520, height: 680, minWidth: 420, minHeight: 480, resizable: true, show: false }
  },
  settings: {
    id: 'settings',
    route: 'settings',
    closeBehavior: 'hide',
    options: { width: 760, height: 620, minWidth: 620, minHeight: 480, resizable: true, show: false }
  }
}
