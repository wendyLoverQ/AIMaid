import { describe, expect, it } from 'vitest'
import {
  easeOutCubic,
  PET_HOLD_GROWTH_PER_MS,
  PET_HOLD_RELEASE_MS
} from '../src/shared/pet-hold-scale'

describe('pet hold scale', () => {
  it('matches the legacy continuous hold growth rate', () => {
    expect(PET_HOLD_GROWTH_PER_MS * 16).toBeCloseTo(0.02)
    expect(1 + PET_HOLD_GROWTH_PER_MS * 800).toBeCloseTo(2)
  })

  it('matches the legacy 140ms cubic ease-out release', () => {
    expect(PET_HOLD_RELEASE_MS).toBe(140)
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875)
    expect(easeOutCubic(1)).toBe(1)
  })
})
