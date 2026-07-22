export const ALPHA_CONTOUR_ANGLE_COUNT = 192
const ALPHA_THRESHOLD = 24

export interface ContourPoint {
  x: number
  y: number
}

export interface AlphaContour {
  center: ContourPoint
  points: ContourPoint[]
}

export function buildOuterAlphaContour(pixels: Uint8ClampedArray, width: number, height: number): AlphaContour | null {
  let opaqueCount = 0
  let centerX = 0
  let centerY = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3]! < ALPHA_THRESHOLD) continue
      opaqueCount += 1
      centerX += x + 0.5
      centerY += y + 0.5
    }
  }
  if (opaqueCount === 0) return null
  centerX /= opaqueCount
  centerY /= opaqueCount

  const radii = new Float32Array(ALPHA_CONTOUR_ANGLE_COUNT)
  const points = new Array<ContourPoint | null>(ALPHA_CONTOUR_ANGLE_COUNT).fill(null)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3]! < ALPHA_THRESHOLD) continue
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      const radius = Math.hypot(dx, dy)
      const normalizedAngle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)
      const index = Math.round(normalizedAngle / (Math.PI * 2) * ALPHA_CONTOUR_ANGLE_COUNT) % ALPHA_CONTOUR_ANGLE_COUNT
      if (radius <= radii[index]!) continue
      radii[index] = radius
      points[index] = { x: (x + 0.5) / width, y: (y + 0.5) / height }
    }
  }

  fillContourGaps(points)
  const complete = points.filter((point): point is ContourPoint => point !== null)
  if (complete.length !== ALPHA_CONTOUR_ANGLE_COUNT) return null
  return { center: { x: centerX / width, y: centerY / height }, points: complete }
}

function fillContourGaps(points: Array<ContourPoint | null>): void {
  for (let index = 0; index < points.length; index += 1) {
    if (points[index] !== null) continue
    let before = 1
    while (before < points.length && points[(index - before + points.length) % points.length] === null) before += 1
    let after = 1
    while (after < points.length && points[(index + after) % points.length] === null) after += 1
    const start = points[(index - before + points.length) % points.length]
    const end = points[(index + after) % points.length]
    if (start == null || end == null) continue
    const progress = before / (before + after)
    points[index] = {
      x: start.x + (end.x - start.x) * progress,
      y: start.y + (end.y - start.y) * progress
    }
  }
}
