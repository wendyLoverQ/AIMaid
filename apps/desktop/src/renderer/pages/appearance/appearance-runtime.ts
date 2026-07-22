import type { AppearanceConfigurationDto } from '../../../shared/business'

const STORAGE_KEY = 'aimaid.appearance.current'
const CHANGE_EVENT = 'aimaid-appearance-changed'

interface StoredAppearance {
  configuration: AppearanceConfigurationDto
  colors: readonly [string, string, string, string]
}

export function saveAndApplyAppearance(configuration: AppearanceConfigurationDto, colors: readonly [string, string, string, string]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ configuration, colors } satisfies StoredAppearance))
  applyAppearance(configuration, colors)
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function applyStoredAppearance(): void {
  const value = readStoredAppearance()
  if (value === null) return
  if (!isSupportedPalette(value.colors)) {
    localStorage.removeItem(STORAGE_KEY)
    return
  }
  applyAppearance(value.configuration, value.colors)
}

export function subscribeAppearance(listener: () => void): () => void {
  const storageListener = (event: StorageEvent): void => { if (event.key === STORAGE_KEY) listener() }
  window.addEventListener('storage', storageListener)
  window.addEventListener(CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', storageListener)
    window.removeEventListener(CHANGE_EVENT, listener)
  }
}

function readStoredAppearance(): StoredAppearance | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<StoredAppearance> | null
    return value !== null && value.configuration !== undefined && Array.isArray(value.colors) && value.colors.length === 4
      ? value as StoredAppearance
      : null
  } catch {
    return null
  }
}

function applyAppearance(configuration: AppearanceConfigurationDto, colors: readonly [string, string, string, string]): void {
  const root = document.documentElement
  const [canvas, surface, elevated, accent] = colors
  const target = configuration.contentBrightness === 'Soft' ? canvas : configuration.contentBrightness === 'Clear' ? elevated : surface
  const amount = configuration.contentBrightness === 'Soft' ? 0.08 : configuration.contentBrightness === 'Clear' ? 0.06 : 0
  const content = amount === 0 ? surface : mix(surface, target, amount)
  root.style.setProperty('--color-bg-canvas', canvas)
  root.style.setProperty('--color-bg-surface', content)
  root.style.setProperty('--color-bg-elevated', elevated)
  root.style.setProperty('--color-accent', accent)
  root.style.setProperty('--color-focus', accent)
  root.style.setProperty('--color-text-primary', '#222528')
  root.style.setProperty('--color-text-secondary', '#565C62')
  root.style.setProperty('--color-text-muted', '#767E86')
  root.style.setProperty('--font-family-sans', configuration.fontFamily === '' ? 'Inter, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif' : `"${configuration.fontFamily}", "Segoe UI", sans-serif`)
  root.style.fontSize = `${configuration.fontScale * 100}%`
  const radii: [string, string, string] = configuration.cornerRadiusStyle === 'Small' ? ['.25rem', '.375rem', '.5rem'] : configuration.cornerRadiusStyle === 'Large' ? ['.5rem', '.875rem', '1.25rem'] : ['.375rem', '.625rem', '.875rem']
  root.style.setProperty('--radius-sm', radii[0])
  root.style.setProperty('--radius-md', radii[1])
  root.style.setProperty('--radius-lg', radii[2])
  const spacing = configuration.density === 'Compact' ? 0.85 : configuration.density === 'Comfortable' ? 1.15 : 1
  root.style.setProperty('--appearance-density-scale', String(spacing))
  root.style.setProperty('--space-2', `${0.5 * spacing}rem`)
  root.style.setProperty('--space-3', `${0.75 * spacing}rem`)
  root.style.setProperty('--space-4', `${1 * spacing}rem`)
  root.style.setProperty('--space-5', `${1.25 * spacing}rem`)
  root.style.setProperty('--space-6', `${1.5 * spacing}rem`)
  root.style.setProperty('--duration-fast', configuration.animationsEnabled ? '120ms' : '0ms')
  root.style.setProperty('--duration-normal', configuration.animationsEnabled ? '180ms' : '0ms')
  root.style.setProperty('--duration-slow', configuration.animationsEnabled ? '280ms' : '0ms')
  root.dataset.headerStyle = configuration.headerStyle
  root.style.colorScheme = 'only light'
}

function isSupportedPalette(colors: readonly [string, string, string, string]): boolean {
  return luminance(colors[0]) >= 0.72 && luminance(colors[1]) >= 0.68 && luminance(colors[2]) >= 0.82
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex)
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255)
}

function mix(source: string, target: string, amount: number): string {
  const [ar, ag, ab] = channels(source)
  const [br, bg, bb] = channels(target)
  return `#${[mixChannel(ar, br, amount), mixChannel(ag, bg, amount), mixChannel(ab, bb, amount)].join('')}`
}

function mixChannel(source: number, target: number, amount: number): string {
  return Math.round(source + (target - source) * amount).toString(16).padStart(2, '0')
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
}
