export const WINDOW_KINDS = [
  'main', 'pet', 'chat', 'settings', 'status', 'appearance', 'bitcoin', 'timer', 'video',
  'remote-video', 'reminders', 'notebook', 'vault', 'scripts', 'voice-conversation', 'characters',
  'crypto-events', 'crypto-provider', 'crypto-chart', 'video-player', 'video-subtitles', 'remote-site-config',
  'template-card', 'character-editor', 'agent-confirm', 'tray-menu', 'douyin-login',
  'ui-showcase'
] as const

export type WindowKind = (typeof WINDOW_KINDS)[number]

export type WindowAction = 'open' | 'show' | 'hide' | 'close' | 'focus'

export interface OpenWindowPayload {
  target: WindowKind
}

export function isWindowKind(value: unknown): value is WindowKind {
  return typeof value === 'string' && WINDOW_KINDS.some((kind) => kind === value)
}
