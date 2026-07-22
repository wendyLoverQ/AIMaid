import { describe, expect, it } from 'vitest'
import { positionWindowNearPet } from '../src/main/windows/window-positioning'

describe('pet-relative window positioning', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  const pet = { x: 1200, y: 400, width: 400, height: 600 }

  it('centers a first-open tool window on the PET item', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 480, height: 560 }, pet, workArea
    )).toEqual({ x: 1160, y: 420, width: 480, height: 560 })
  })

  it('centers the status window on the pet anchor', () => {
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 480, height: 720 }, pet, workArea
    )).toEqual({ x: 1160, y: 320, width: 480, height: 720 })
  })

  it('keeps windows inside the pet display work area', () => {
    const secondary = { x: -1600, y: 0, width: 1600, height: 900 }
    const edgePet = { x: -320, y: 500, width: 280, height: 480 }
    expect(positionWindowNearPet(
      { x: 0, y: 0, width: 760, height: 560 }, edgePet, secondary
    )).toEqual({ x: -760, y: 340, width: 760, height: 560 })
  })

})
