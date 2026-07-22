import { describe, expect, it } from 'vitest'
import { petWindowAlignment, physicalPetItemBoundsToDip, positionWindowNearPet } from '../src/main/windows/window-positioning'

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

  it('maps the fullscreen item through the physical virtual desktop on the 175% display', () => {
    const screenToDipPoint = ({ x, y }: { x: number; y: number }) => ({
      x: x >= 2560 ? 2048 + (x - 2560) / 1.75 : x / 1.25,
      y: x >= 2560 ? -723 + (y + 1264) / 1.75 : y / 1.25
    })
    const mapped = physicalPetItemBoundsToDip(
      { x: -1440, y: -1264, width: 6160, height: 3840 },
      { x: 3538, y: 996, width: 560, height: 980 },
      1.25,
      screenToDipPoint,
      () => 1.75
    )
    expect(mapped.x).toBeCloseTo(2289.4286, 4)
    expect(mapped.y).toBeCloseTo(-11.5714, 4)
    expect(mapped.width).toBe(400)
    expect(mapped.height).toBe(700)
  })

  it('centers the actual chat window size on the reported item center', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 520, height: 360 },
      { x: 300, y: 100, width: 560, height: 980 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      petWindowAlignment('chat', 'live2d')
    )).toEqual({ x: 320, y: 410, width: 520, height: 360 })
  })
})
