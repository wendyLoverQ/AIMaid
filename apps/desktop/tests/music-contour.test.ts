import { describe, expect, it } from 'vitest'
import { buildOuterAlphaContour } from '../src/shared/alpha-contour'

describe('dynamic pet music contour', () => {
  it('wraps the visible alpha silhouette instead of the rectangular asset bounds', () => {
    const pixels = personFrame(false)
    const contour = buildOuterAlphaContour(pixels, 32, 48)
    expect(contour).not.toBeNull()
    expect(contour?.points).toHaveLength(192)
    expect(Math.min(...contour!.points.map((point) => point.x))).toBeGreaterThan(0.1)
    expect(Math.max(...contour!.points.map((point) => point.x))).toBeLessThan(0.9)
    expect(Math.min(...contour!.points.map((point) => point.y))).toBeGreaterThan(0)
    expect(Math.max(...contour!.points.map((point) => point.y))).toBeLessThan(1)
  })

  it('rebuilds to follow a moving limb in a later animation frame', () => {
    const resting = buildOuterAlphaContour(personFrame(false), 32, 48)
    const moving = buildOuterAlphaContour(personFrame(true), 32, 48)
    const restingLeft = Math.min(...resting!.points.map((point) => point.x))
    const movingLeft = Math.min(...moving!.points.map((point) => point.x))
    expect(movingLeft).toBeLessThan(restingLeft - 0.1)
  })
})

function personFrame(raisedArm: boolean): Uint8ClampedArray {
  const width = 32
  const height = 48
  const pixels = new Uint8ClampedArray(width * height * 4)
  const opaque = (x: number, y: number): void => { pixels[(y * width + x) * 4 + 3] = 255 }
  for (let y = 4; y <= 13; y += 1) {
    for (let x = 11; x <= 20; x += 1) {
      if (Math.hypot(x - 15.5, y - 8.5) <= 5.5) opaque(x, y)
    }
  }
  for (let y = 13; y <= 35; y += 1) for (let x = 10; x <= 21; x += 1) opaque(x, y)
  for (let y = 36; y <= 46; y += 1) {
    for (let x = 10; x <= 14; x += 1) opaque(x, y)
    for (let x = 17; x <= 21; x += 1) opaque(x, y)
  }
  if (raisedArm) {
    for (let step = 0; step <= 15; step += 1) {
      const x = 10 - Math.round(step * 0.55)
      const y = 18 - step
      for (let offset = -1; offset <= 1; offset += 1) opaque(x + offset, y)
    }
  } else {
    for (let x = 6; x <= 9; x += 1) for (let y = 17; y <= 30; y += 1) opaque(x, y)
  }
  return pixels
}
