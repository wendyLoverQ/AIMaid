import { describe, expect, it } from 'vitest'
import { intersectRectangles, mapLocalRectangleToPhysical } from '../src/main/windows/pet-coordinate-mapping'

describe('PET coordinate mapping', () => {
  const contentDipBounds = { x: -1152, y: -1011, width: 4928, height: 3072 }
  const contentPhysicalBounds = { x: -1440, y: -1264, width: 6160, height: 3840 }

  it('maps renderer-local coordinates through the physical virtual desktop window', () => {
    expect(mapLocalRectangleToPhysical(
      { x: 2184, y: 1046, width: 560, height: 980 },
      contentDipBounds,
      contentPhysicalBounds
    )).toEqual({ x: 1290, y: 44, width: 700, height: 1225 })
  })

  it('keeps a moved PET in physical coordinates even when global DIP spaces differ', () => {
    expect(mapLocalRectangleToPhysical(
      { x: 3600, y: 600, width: 560, height: 980 },
      contentDipBounds,
      contentPhysicalBounds
    )).toEqual({ x: 3060, y: -514, width: 700, height: 1225 })
  })

  it('intersects physical rectangles without applying another display scale', () => {
    expect(intersectRectangles(
      { x: 2400, y: 100, width: 700, height: 900 },
      { x: 2560, y: -1264, width: 2160, height: 3840 }
    )).toEqual({ x: 2560, y: 100, width: 540, height: 900 })
  })
})
