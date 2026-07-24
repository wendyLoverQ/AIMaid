export function spectrumPeak(spectrum: Uint8Array): number {
  let peak = 1
  for (const value of spectrum) peak = Math.max(peak, value)
  return peak
}

export function barSpectrumTarget(spectrum: Uint8Array, peak: number, barIndex: number): number {
  if (spectrum.length === 0) return 0
  const center = positiveModulo(barIndex, spectrum.length)
  const previous = spectrum[Math.max(0, center - 1)]!
  const current = spectrum[center]!
  const next = spectrum[Math.min(spectrum.length - 1, center + 1)]!
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
  const minimumHz = Math.max(binHz, 20)
  const maximumHz = Math.min(20_000, sampleRate / 2, source.length * binHz)
  const ratio = maximumHz / minimumHz
  for (let band = 0; band < target.length; band += 1) {
    const startHz = minimumHz * Math.pow(ratio, band / target.length)
    const endHz = minimumHz * Math.pow(ratio, (band + 1) / target.length)
    const startBin = Math.max(1, Math.min(source.length - 1, Math.floor(startHz / binHz)))
    const endBin = Math.max(startBin + 1, Math.min(source.length, Math.ceil(endHz / binHz)))
    let sum = 0
    for (let bin = startBin; bin < endBin; bin += 1) sum += source[bin]!
    target[band] = Math.round(sum / (endBin - startBin))
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
