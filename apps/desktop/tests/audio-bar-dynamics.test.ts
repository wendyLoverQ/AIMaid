import { describe, expect, it } from 'vitest'
import { advanceBarDynamics, barSpectrumTarget, resampleLogFrequencyBands, spectrumPeak } from '../src/shared/audio-bar-dynamics'

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

  it('maps the full audible analyser range into ordered logarithmic bands', () => {
    const source = new Uint8Array(512)
    source[2] = 220
    source[64] = 180
    source[320] = 240
    const target = new Uint8Array(48)

    resampleLogFrequencyBands(source, target, 48_000, 1024)

    const activeBands = Array.from(target.entries()).filter(([, value]) => value > 0).map(([index]) => index)
    expect(activeBands.length).toBeGreaterThanOrEqual(3)
    expect(Math.min(...activeBands)).toBeLessThan(10)
    expect(Math.max(...activeBands)).toBeGreaterThan(40)
  })
})
