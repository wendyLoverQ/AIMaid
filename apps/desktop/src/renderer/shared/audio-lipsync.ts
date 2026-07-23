import type { PetLipSyncSource } from '../../shared/pet'
import { computeLipSyncLevel } from '../../shared/audio-lipsync'
import { bridge } from './bridge'

export function publishAudioLipSync(source: PetLipSyncSource, analyser: AnalyserNode): () => void {
  const samples = new Float32Array(analyser.fftSize)
  let animationFrame = 0
  let stopped = false

  const sample = (): void => {
    if (stopped) return
    analyser.getFloatTimeDomainData(samples)
    bridge.pet.publishLipSync({
      source,
      level: computeLipSyncLevel(samples),
      active: true,
      timestamp: Date.now()
    })
    animationFrame = requestAnimationFrame(sample)
  }

  sample()
  return () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(animationFrame)
    bridge.pet.publishLipSync({ source, level: 0, active: false, timestamp: Date.now() })
  }
}
