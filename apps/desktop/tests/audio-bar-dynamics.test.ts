import { describe, expect, it } from 'vitest'
import { advanceBarDynamics, barSpectrumTarget, spectrumPeak } from '../src/shared/audio-bar-dynamics'

describe('pet audio bar dynamics', () => {
  it('gives adjacent bars distinct frequency-driven targets', () => {
    const spectrum = Uint8Array.from({ length: 96 }, (_, index) => (index * 43 + index * index * 7) % 256)
    const peak = spectrumPeak(spectrum)
    const targets = Array.from({ length: 16 }, (_, index) => barSpectrumTarget(spectrum, peak, index))
    expect(new Set(targets.map((value) => value.toFixed(4))).size).toBeGreaterThan(12)
  })

  it('tracks each bar independently with a faster attack than release', () => {
    const rising = advanceBarDynamics(0, 0.8, 3)
    const falling = advanceBarDynamics(0.8, 0, 3)
    expect(rising).toBeGreaterThan(0.4)
    expect(0.8 - falling).toBeLessThan(0.2)
    expect(advanceBarDynamics(0, 0.8, 4)).not.toBe(rising)
  })
})
