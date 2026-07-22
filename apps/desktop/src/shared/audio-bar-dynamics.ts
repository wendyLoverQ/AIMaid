export function spectrumPeak(spectrum: Uint8Array): number {
  let peak = 1
  for (const value of spectrum) peak = Math.max(peak, value)
  return peak
}

export function barSpectrumTarget(spectrum: Uint8Array, peak: number, barIndex: number): number {
  if (spectrum.length === 0) return 0
  // Coprime strides scatter adjacent bars across different frequency bins.
  // A secondary bin avoids repeated shapes when there are more bars than bins.
  const primary = spectrum[(barIndex * 37) % spectrum.length]!
  const secondary = spectrum[(barIndex * 61 + 17) % spectrum.length]!
  const mixed = (primary * 0.78 + secondary * 0.22) / Math.max(1, peak)
  const gated = Math.max(0, (mixed - 0.06) / 0.94)
  return Math.pow(gated, 1.7)
}

export function advanceBarDynamics(current: number, target: number, barIndex: number): number {
  const response = target >= current
    ? 0.46 + barIndex % 5 * 0.035
    : 0.11 + barIndex % 7 * 0.012
  return current + (target - current) * response
}
