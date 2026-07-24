import type { AlphaContour } from './alpha-contour'

export const MUSIC_VISUALIZER_STYLE_KEY = 'music_visualizer_style'
export const RADIAL_BAR_COUNT = 72

export type MusicVisualizerStyle =
  | 'surround-line'
  | 'bottom-wave'
  | 'radial-bars'
  | 'circular-wave'
  | 'pulse-rings'

export type BackgroundMusicVisualizerStyle = 'radial-bars' | 'circular-wave' | 'pulse-rings'

export const MUSIC_VISUALIZER_STYLE_OPTIONS: ReadonlyArray<readonly [MusicVisualizerStyle, string]> = [
  ['surround-line', '环绕线条'],
  ['bottom-wave', '底部倒置柱状'],
  ['radial-bars', '背景镜像柱状圆环'],
  ['circular-wave', '背景圆形波形线'],
  ['pulse-rings', '背景同心脉冲']
]

export function parseMusicVisualizerStyle(value: unknown): MusicVisualizerStyle {
  return value === 'surround-line' || value === 'bottom-wave' || value === 'radial-bars' ||
    value === 'circular-wave' || value === 'pulse-rings' ? value : 'surround-line'
}

export function isBackgroundMusicVisualizer(style: MusicVisualizerStyle): style is BackgroundMusicVisualizerStyle {
  return style === 'radial-bars' || style === 'circular-wave' || style === 'pulse-rings'
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

export interface RadialVisualizerLayout {
  readonly normalizedCenterX: number
  readonly normalizedCenterY: number
  readonly radius: number
}

export function createRadialVisualizerLayout(
  contour: AlphaContour,
  sourceWidth: number,
  sourceHeight: number
): RadialVisualizerLayout {
  const left = Math.min(...contour.points.map((point) => point.x))
  const right = Math.max(...contour.points.map((point) => point.x))
  const top = Math.min(...contour.points.map((point) => point.y))
  const bottom = Math.max(...contour.points.map((point) => point.y))
  const visibleWidth = (right - left) * sourceWidth
  const visibleHeight = (bottom - top) * sourceHeight
  return {
    normalizedCenterX: contour.center.x,
    normalizedCenterY: contour.center.y,
    radius: Math.min(260, Math.max(90, Math.max(visibleWidth, visibleHeight) * 0.32))
  }
}
