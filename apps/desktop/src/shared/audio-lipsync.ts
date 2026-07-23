const ANALYSIS_SCALE = Math.sqrt(20)

export function computeLipSyncLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sumOfSquares = 0
  for (const sample of samples) sumOfSquares += sample * sample
  const analyzed = Number((Math.sqrt(sumOfSquares / samples.length) * ANALYSIS_SCALE).toFixed(1))
  return analyzed > 0 ? Math.min(1, Math.max(0.4, analyzed * 1.2)) : 0
}
