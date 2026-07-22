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
