export function spectrumPeak(spectrum: Uint8Array): number {
  let peak = 1
  for (const value of spectrum) peak = Math.max(peak, value)
  return peak
}

export function barSpectrumTarget(spectrum: Uint8Array, peak: number, barIndex: number): number {
  if (spectrum.length === 0) return 0
  const center = positiveModulo(barIndex, spectrum.length)
  const previous = spectrum[positiveModulo(center - 1, spectrum.length)]!
  const current = spectrum[center]!
  const next = spectrum[(center + 1) % spectrum.length]!
  const mixed = (previous * 0.18 + current * 0.64 + next * 0.18) / Math.max(1, peak)
  const gated = Math.max(0, (mixed - 0.06) / 0.94)
  return Math.pow(gated, 1.7)
}

export function resampleLogFrequencyBands(
  source: Uint8Array,
  target: Uint8Array,
  sampleRate: number,
  fftSize: number
): void {
  if (source.length === 0 || target.length === 0 || sampleRate <= 0 || fftSize <= 0) {
    target.fill(0)
    return
  }
  const binHz = sampleRate / fftSize
  const minimumHz = Math.max(binHz, 55)
  const maximumHz = Math.min(16_000, sampleRate / 2, source.length * binHz)
  const ratio = maximumHz / minimumHz
  for (let band = 0; band < target.length; band += 1) {
    const startHz = minimumHz * Math.pow(ratio, band / target.length)
    const endHz = minimumHz * Math.pow(ratio, (band + 1) / target.length)
    const startBin = Math.max(1, Math.min(source.length - 1, Math.floor(startHz / binHz)))
    const endBin = Math.max(startBin + 1, Math.min(source.length, Math.ceil(endHz / binHz)))
    let squared = 0
    for (let bin = startBin; bin < endBin; bin += 1) {
      const normalized = source[bin]! / 255
      squared += normalized * normalized
    }
    target[band] = Math.round(Math.sqrt(squared / (endBin - startBin)) * 255)
  }
}

export function advanceBarDynamics(current: number, target: number, barIndex: number): number {
  const response = target >= current
    ? 0.46 + barIndex % 5 * 0.035
    : 0.11 + barIndex % 7 * 0.012
  return current + (target - current) * response
}

function positiveModulo(value: number, divisor: number): number {
  return (value % divisor + divisor) % divisor
}
