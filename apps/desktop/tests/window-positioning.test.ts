import { describe, expect, it } from 'vitest'
import { petWindowAlignment, positionWindowNearPet, resolvePetVisualBounds } from '../src/main/windows/window-positioning'

describe('pet-relative window positioning', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  const pet = { x: 1200, y: 400, width: 400, height: 600 }

  it('places regular tool windows to the right of the pet center anchor', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 480, height: 560 }, pet, workArea, 'right-of-center'
    )).toEqual({ x: 1416, y: 420, width: 480, height: 560 })
  })

  it('centers the status window on the pet anchor', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 480, height: 720 }, pet, workArea, 'center'
    )).toEqual({ x: 1160, y: 320, width: 480, height: 720 })
  })

  it('keeps windows inside the pet display work area', () => {
    const secondary = { x: -1600, y: 0, width: 1600, height: 900 }
    const edgePet = { x: -320, y: 500, width: 280, height: 480 }
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 760, height: 560 }, edgePet, secondary, 'right-of-center'
    )).toEqual({ x: -760, y: 340, width: 760, height: 560 })
  })

  it('uses the legacy display-mode alignment rules', () => {
    expect(petWindowAlignment('chat', 'live2d')).toBe('center')
    expect(petWindowAlignment('video', 'live2d')).toBe('right-of-center')
    expect(petWindowAlignment('video', 'image')).toBe('center')
    expect(petWindowAlignment('video', 'png-sequence')).toBe('center')
    expect(petWindowAlignment('status', 'live2d')).toBe('center')
  })

  it('converts renderer-relative pet bounds inside a full virtual-desktop window to screen coordinates', () => {
    expect(resolvePetVisualBounds(
      { x: -1920, y: -200, width: 4480, height: 1640 },
      { x: 3120, y: 620, width: 560, height: 980 }
    )).toEqual({ x: 1200, y: 420, width: 560, height: 980 })
  })

  it('maps a pet center through physical pixels on a mixed-DPI three-screen desktop', () => {
    const mapped = resolvePetVisualBounds(
      { x: -1152, y: -1011, width: 4928, height: 3073 },
      { x: 3720, y: 300, width: 560, height: 400 },
      {
        dipToScreenPoint: ({ x, y }) => ({ x: Math.round(x * 1.25), y: Math.round(y * 1.25) }),
        screenToDipPoint: ({ x, y }) => ({
          x: 2048 + (x - 2560) / 1.75,
          y: -723 + (y + 1264) / 1.75
        })
      },
      1.25
    )

    expect(mapped.x + mapped.width / 2).toBeCloseTo(2619.43, 2)
    expect(mapped.y + mapped.height / 2).toBeCloseTo(-365.86, 2)
  })

  it('uses the centered pet item as the deterministic initial anchor before the renderer report arrives', () => {
    expect(resolvePetVisualBounds(
      { x: 0, y: 0, width: 1920, height: 1080 }
    )).toEqual({ x: 680, y: 50, width: 560, height: 980 })
  })
})
