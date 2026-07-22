import type { Rectangle } from 'electron'

export function mapLocalRectangleToPhysical(
  localBounds: Rectangle,
  contentDipBounds: Rectangle,
  contentPhysicalBounds: Rectangle
): Rectangle {
  if (contentDipBounds.width <= 0 || contentDipBounds.height <= 0) throw new RangeError('PET content bounds must be positive')
  const scaleX = contentPhysicalBounds.width / contentDipBounds.width
  const scaleY = contentPhysicalBounds.height / contentDipBounds.height
  const left = contentPhysicalBounds.x + Math.round(localBounds.x * scaleX)
  const top = contentPhysicalBounds.y + Math.round(localBounds.y * scaleY)
  const right = contentPhysicalBounds.x + Math.round((localBounds.x + localBounds.width) * scaleX)
  const bottom = contentPhysicalBounds.y + Math.round((localBounds.y + localBounds.height) * scaleY)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function intersectRectangles(left: Rectangle, right: Rectangle): Rectangle | null {
  const x = Math.max(left.x, right.x)
  const y = Math.max(left.y, right.y)
  const rightEdge = Math.min(left.x + left.width, right.x + right.width)
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height)
  if (rightEdge <= x || bottomEdge <= y) return null
  return { x, y, width: rightEdge - x, height: bottomEdge - y }
}
