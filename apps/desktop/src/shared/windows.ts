export const WINDOW_KINDS = ['main', 'pet', 'chat', 'settings'] as const

export type WindowKind = (typeof WINDOW_KINDS)[number]

export type WindowAction = 'open' | 'show' | 'hide' | 'close' | 'focus'

export interface OpenWindowPayload {
  target: WindowKind
}

export function isWindowKind(value: unknown): value is WindowKind {
  return typeof value === 'string' && WINDOW_KINDS.some((kind) => kind === value)
}
