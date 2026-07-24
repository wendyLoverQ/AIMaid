import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { PetLipSyncFrame } from '../../../shared/pet'
import { PET_CANVAS_HEIGHT, PET_CANVAS_WIDTH } from '../../../shared/pet-geometry'
import { bridge } from '../../shared/bridge'

const STRIP_COUNT = 30
const INHALE_MS = 1_700
const INHALE_HOLD_MS = 200
const EXHALE_MS = 2_400
const EXHALE_HOLD_MS = 400
const POINTER_PROXIMITY_PX = 72

interface ImageIdleController {
  triggerAttention: (direction?: number) => void
}

interface LipSyncState {
  ttsActive: boolean
  ttsLevel: number
  musicActive: boolean
  musicLevel: number
}

interface BreathCycle {
  startedAt: number
  inhaleMs: number
  inhaleHoldMs: number
  exhaleMs: number
  exhaleHoldMs: number
  amplitude: number
}

interface WeightShift {
  startedAt: number
  durationMs: number
  distance: number
}

interface LongExhale {
  startedAt: number
  durationMs: number
}

interface AttentionMotion {
  startedAt: number
  durationMs: number
  direction: number
}

export function useImageModeIdleAnimation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  url: string | null,
  scale: number,
  attentionKey: string,
  onFirstFrame: () => void
): void {
  const controllerRef = useRef<ImageIdleController | null>(null)

  useEffect(() => {
    if (attentionKey !== '') controllerRef.current?.triggerAttention()
  }, [attentionKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || url === null) return

    const image = new Image()
    image.crossOrigin = 'anonymous'
    let animationFrame = 0
    let disposed = false
    let sourceCanvas: HTMLCanvasElement | null = null
    let sourceWidth = 0
    let sourceHeight = 0
    let pointerWasNear = false
    let lastFrameAt = performance.now()
    let smoothedTtsLevel = 0
    let smoothedMusicLevel = 0
    let cycle = createBreathCycle(lastFrameAt)
    let weightShift: WeightShift | null = null
    let nextWeightShiftAt = lastFrameAt + randomBetween(7_000, 18_000)
    let longExhale: LongExhale | null = null
    let nextLongExhaleAt = lastFrameAt + randomBetween(18_000, 42_000)
    let attention: AttentionMotion | null = null
    const lipSync: LipSyncState = {
      ttsActive: false,
      ttsLevel: 0,
      musicActive: false,
      musicLevel: 0
    }

    const triggerAttention = (direction = 0): void => {
      const startedAt = performance.now()
      attention = {
        startedAt,
        durationMs: randomBetween(400, 800),
        direction: direction === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(direction)
      }
    }
    controllerRef.current = { triggerAttention }

    const onMouseMove = (event: MouseEvent): void => {
      const bounds = canvas.getBoundingClientRect()
      const distanceX = Math.max(bounds.left - event.clientX, 0, event.clientX - bounds.right)
      const distanceY = Math.max(bounds.top - event.clientY, 0, event.clientY - bounds.bottom)
      const near = Math.hypot(distanceX, distanceY) <= POINTER_PROXIMITY_PX
      if (near && !pointerWasNear)
        triggerAttention(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1)
      pointerWasNear = near
    }

    const onLipSync = (frame: PetLipSyncFrame): void => {
      if (frame.source === 'tts') {
        if (frame.active && !lipSync.ttsActive) triggerAttention()
        lipSync.ttsActive = frame.active
        lipSync.ttsLevel = frame.active ? frame.level : 0
        return
      }
      lipSync.musicActive = frame.active
      lipSync.musicLevel = frame.active ? frame.level : 0
    }

    const ensureSourceCanvas = (): HTMLCanvasElement | null => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null
      if (sourceCanvas !== null && sourceWidth === canvas.width && sourceHeight === canvas.height)
        return sourceCanvas
      const next = document.createElement('canvas')
      next.width = canvas.width
      next.height = canvas.height
      const context = next.getContext('2d')
      if (context === null) return null
      const imageScale = Math.min(next.width / image.naturalWidth, next.height / image.naturalHeight)
      const drawWidth = image.naturalWidth * imageScale
      const drawHeight = image.naturalHeight * imageScale
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.clearRect(0, 0, next.width, next.height)
      context.drawImage(image, (next.width - drawWidth) / 2, (next.height - drawHeight) / 2, drawWidth, drawHeight)
      sourceCanvas = next
      sourceWidth = canvas.width
      sourceHeight = canvas.height
      return next
    }

    const render = (now: number): void => {
      if (disposed) return
      const source = ensureSourceCanvas()
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (source === null || context === null) {
        animationFrame = requestAnimationFrame(render)
        return
      }

      while (now >= breathCycleEnd(cycle))
        cycle = createBreathCycle(breathCycleEnd(cycle))

      if (weightShift === null && now >= nextWeightShiftAt) {
        weightShift = {
          startedAt: now,
          durationMs: randomBetween(2_600, 4_200),
          distance: randomBetween(1, 3) * (Math.random() < 0.5 ? -1 : 1)
        }
      }
      if (weightShift !== null && now >= weightShift.startedAt + weightShift.durationMs) {
        weightShift = null
        nextWeightShiftAt = now + randomBetween(7_000, 18_000)
      }
      if (longExhale === null && now >= nextLongExhaleAt) {
        longExhale = { startedAt: now, durationMs: randomBetween(3_000, 5_000) }
      }
      if (longExhale !== null && now >= longExhale.startedAt + longExhale.durationMs) {
        longExhale = null
        nextLongExhaleAt = now + randomBetween(18_000, 42_000)
      }
      if (attention !== null && now >= attention.startedAt + attention.durationMs)
        attention = null

      const elapsed = Math.min(50, Math.max(0, now - lastFrameAt))
      lastFrameAt = now
      const ttsFollow = 1 - Math.exp(-elapsed / 150)
      const musicFollow = 1 - Math.exp(-elapsed / 240)
      smoothedTtsLevel += ((lipSync.ttsActive ? lipSync.ttsLevel : 0) - smoothedTtsLevel) * ttsFollow
      smoothedMusicLevel += ((lipSync.musicActive ? lipSync.musicLevel : 0) - smoothedMusicLevel) * musicFollow

      const pixelScale = canvas.width / PET_CANVAS_WIDTH
      const breath = breathValue(cycle, now)
      const longExhaleProgress = longExhale === null ? 0 : motionPulse((now - longExhale.startedAt) / longExhale.durationMs)
      const ordinaryBreath = longExhale === null ? breath : breath * 0.15
      const speakingFactor = lipSync.ttsActive || smoothedTtsLevel > 0.02 ? 0.55 : 1
      const musicFactor = 1 + smoothedMusicLevel * 0.15
      const breathAmount = ordinaryBreath * cycle.amplitude * speakingFactor * musicFactor
      const weightProgress = weightShift === null ? 0 : motionPulse((now - weightShift.startedAt) / weightShift.durationMs)
      const weightX = weightShift === null ? 0 : weightShift.distance * weightProgress
      const attentionProgress = attention === null ? 0 : motionPulse((now - attention.startedAt) / attention.durationMs)
      const attentionX = attention === null ? 0 : attention.direction * 1.2 * attentionProgress
      const speakingRise = smoothedTtsLevel * 0.55
      const stripHeight = canvas.height / STRIP_COUNT

      context.clearRect(0, 0, canvas.width, canvas.height)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      for (let index = 0; index < STRIP_COUNT; index += 1) {
        const normalizedY = (index + 0.5) / STRIP_COUNT
        const chest = chestWeight(normalizedY)
        const head = headWeight(normalizedY)
        const upper = upperBodyWeight(normalizedY)
        const sourceY = index * stripHeight
        const overlap = index === STRIP_COUNT - 1 ? 0 : Math.max(1, pixelScale)
        const breathY = -(head * 1.4 + chest * 3.2) * breathAmount
        const relaxY = chest * 2.2 * longExhaleProgress
        const attentionY = -(head * 1.8 + chest * 2.8) * attentionProgress
        const yOffset = (breathY + relaxY + attentionY - upper * speakingRise) * pixelScale
        const xOffset = upper * (weightX + attentionX) * pixelScale
        const xExpand = chest * (0.75 * breathAmount + 0.25 * attentionProgress) * pixelScale
        context.drawImage(
          source,
          0,
          sourceY,
          canvas.width,
          Math.min(stripHeight + overlap, canvas.height - sourceY),
          xOffset - xExpand,
          sourceY + yOffset,
          canvas.width + xExpand * 2,
          Math.min(stripHeight + overlap, canvas.height - sourceY)
        )
      }
      animationFrame = requestAnimationFrame(render)
    }

    const unsubscribeLipSync = bridge.pet.onLipSync(onLipSync)
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    image.onload = () => {
      if (disposed) return
      render(performance.now())
      onFirstFrame()
    }
    image.src = url

    return () => {
      disposed = true
      image.onload = null
      cancelAnimationFrame(animationFrame)
      unsubscribeLipSync()
      window.removeEventListener('mousemove', onMouseMove)
      if (controllerRef.current?.triggerAttention === triggerAttention)
        controllerRef.current = null
    }
  }, [canvasRef, onFirstFrame, scale, url])
}

function createBreathCycle(startedAt: number): BreathCycle {
  const durationFactor = randomBetween(0.9, 1.1)
  return {
    startedAt,
    inhaleMs: INHALE_MS * durationFactor,
    inhaleHoldMs: INHALE_HOLD_MS * durationFactor,
    exhaleMs: EXHALE_MS * durationFactor,
    exhaleHoldMs: EXHALE_HOLD_MS * durationFactor,
    amplitude: randomBetween(0.85, 1.15)
  }
}

function breathCycleEnd(cycle: BreathCycle): number {
  return cycle.startedAt + cycle.inhaleMs + cycle.inhaleHoldMs + cycle.exhaleMs + cycle.exhaleHoldMs
}

function breathValue(cycle: BreathCycle, now: number): number {
  const elapsed = Math.max(0, now - cycle.startedAt)
  if (elapsed < cycle.inhaleMs) return smoothstep(elapsed / cycle.inhaleMs)
  if (elapsed < cycle.inhaleMs + cycle.inhaleHoldMs) return 1
  const exhaleElapsed = elapsed - cycle.inhaleMs - cycle.inhaleHoldMs
  if (exhaleElapsed < cycle.exhaleMs) return 1 - smoothstep(exhaleElapsed / cycle.exhaleMs)
  return 0
}

function headWeight(y: number): number {
  if (y >= 0.34) return 0
  return 0.45 * (1 - smoothstep((y - 0.18) / 0.16))
}

function chestWeight(y: number): number {
  if (y < 0.16 || y >= 0.72) return 0
  if (y < 0.32) return smoothstep((y - 0.16) / 0.16)
  if (y < 0.48) return 1
  return 1 - smoothstep((y - 0.48) / 0.24) * 0.65
}

function upperBodyWeight(y: number): number {
  if (y >= 0.72) return 0
  if (y <= 0.48) return 1
  return 1 - smoothstep((y - 0.48) / 0.24)
}

function motionPulse(progress: number): number {
  if (progress <= 0 || progress >= 1) return 0
  const sine = Math.sin(Math.PI * progress)
  return sine * sine
}

function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped * clamped * (3 - 2 * clamped)
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum)
}
