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

  it('converts the renderer item rectangle to an absolute desktop rectangle once', () => {
    expect(resolvePetVisualBounds(
      { x: -1920, y: -200, width: 4480, height: 1640 },
      { x: 1200, y: 420, width: 560, height: 980 }
    )).toEqual({ x: -720, y: 220, width: 560, height: 980 })
  })

  it('preserves negative virtual-desktop origins on a three-screen layout', () => {
    expect(resolvePetVisualBounds(
      { x: -1152, y: -1011, width: 4928, height: 3073 },
      { x: 1512, y: 913, width: 560, height: 980 }
    )).toEqual({ x: 360, y: -98, width: 560, height: 980 })
  })

  it('centers the actual chat window size on the reported item center', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 520, height: 360 },
      { x: 300, y: 100, width: 560, height: 980 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      petWindowAlignment('chat', 'live2d')
    )).toEqual({ x: 320, y: 410, width: 520, height: 360 })
  })

  it('uses the centered pet item as the deterministic initial anchor before the renderer report arrives', () => {
    expect(resolvePetVisualBounds(
      { x: 0, y: 0, width: 1920, height: 1080 }
    )).toEqual({ x: 680, y: 50, width: 560, height: 980 })
  })
})
