import type { AlphaContour } from './alpha-contour'

export const MUSIC_VISUALIZER_STYLE_KEY = 'music_visualizer_style'

export type MusicVisualizerStyle = 'surround-bars' | 'surround-line' | 'bottom-wave'

export const MUSIC_VISUALIZER_STYLE_OPTIONS: ReadonlyArray<readonly [MusicVisualizerStyle, string]> = [
  ['surround-bars', '环绕柱条'],
  ['surround-line', '环绕线条'],
  ['bottom-wave', '底部倒置柱状']
]

export function parseMusicVisualizerStyle(value: unknown): MusicVisualizerStyle {
  return value === 'surround-line' || value === 'bottom-wave' ? value : 'surround-bars'
}

export interface BottomBarLayout {
  readonly normalizedCenterX: number
  readonly spacing: number
}

export function createBottomBarLayout(contour: AlphaContour, sourceWidth: number): BottomBarLayout {
  const contourLeft = Math.min(...contour.points.map((point) => point.x))
  const contourRight = Math.max(...contour.points.map((point) => point.x))
  return {
    normalizedCenterX: (contourLeft + contourRight) / 2,
    spacing: Math.min(14, Math.max(1, sourceWidth))
  }
}

export function bottomBarSlots(contour: AlphaContour, sourceWidth: number, spacing: number): number[] {
  const contourLeft = Math.min(...contour.points.map((point) => point.x))
  const contourRight = Math.max(...contour.points.map((point) => point.x))
  const visibleWidth = Math.max(1, (contourRight - contourLeft) * sourceWidth)
  const halfCount = Math.max(1, Math.floor(visibleWidth / (spacing * 2)))
  return Array.from({ length: halfCount * 2 + 1 }, (_, index) => index - halfCount)
}

export function bottomBarIdentity(slot: number): number {
  return slot >= 0 ? slot * 2 : -slot * 2 - 1
}
