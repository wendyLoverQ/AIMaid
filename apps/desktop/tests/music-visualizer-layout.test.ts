import { describe, expect, it } from 'vitest'
import type { AlphaContour } from '../src/shared/alpha-contour'
import {
  bottomBarIdentity,
  bottomBarSlots,
  createBottomBarLayout,
  createRadialVisualizerLayout,
  isBackgroundMusicVisualizer,
  MUSIC_VISUALIZER_STYLE_OPTIONS,
  parseMusicVisualizerStyle
} from '../src/shared/music-visualizer'

function contour(left: number, right: number, bottom = 0.9): AlphaContour {
  return {
    center: { x: (left + right) / 2, y: 0.5 },
    points: [
      { x: left, y: 0.5 },
      { x: 0.5, y: 0.1 },
      { x: right, y: 0.5 },
      { x: 0.5, y: bottom }
    ]
  }
}

describe('bottom music visualizer layout', () => {
  it('keeps the original bar identities when a later alpha frame spreads its arms', () => {
    const initialContour = contour(0.35, 0.65)
    const armsSpread = contour(0.25, 0.75)
    const layout = createBottomBarLayout(initialContour, 140)
    const initialSlots = bottomBarSlots(initialContour, 140, layout.spacing)
    const spreadSlots = bottomBarSlots(armsSpread, 140, layout.spacing)

    expect(layout).toEqual({ normalizedCenterX: 0.5, spacing: 14 })
    expect(initialSlots).toEqual([-1, 0, 1])
    expect(spreadSlots).toEqual([-2, -1, 0, 1, 2])
    expect(spreadSlots.filter((slot) => initialSlots.includes(slot))).toEqual(initialSlots)
    expect(initialSlots.map(bottomBarIdentity)).toEqual([1, 0, 2])
    expect(spreadSlots.filter((slot) => initialSlots.includes(slot)).map(bottomBarIdentity)).toEqual([1, 0, 2])
  })

  it('exposes all three independent background visualizers', () => {
    expect(MUSIC_VISUALIZER_STYLE_OPTIONS.slice(-3)).toEqual([
      ['radial-bars', '背景径向柱状圆环'],
      ['circular-wave', '背景圆形波形线'],
      ['pulse-rings', '背景同心脉冲']
    ])
    for (const style of ['radial-bars', 'circular-wave', 'pulse-rings'] as const) {
      expect(parseMusicVisualizerStyle(style)).toBe(style)
      expect(isBackgroundMusicVisualizer(style)).toBe(true)
    }
  })

  it('locks the radial radius independently of later alpha motion', () => {
    const layout = createRadialVisualizerLayout(contour(0.35, 0.65), 560, 200)
    const armsSpread = contour(0.12, 0.88)

    expect(layout.radius).toBeGreaterThanOrEqual(90)
    expect(layout).toEqual(createRadialVisualizerLayout(contour(0.35, 0.65), 560, 200))
    expect(createRadialVisualizerLayout(armsSpread, 560, 200).radius).toBeGreaterThan(layout.radius)
  })
})
