import { useEffect, useRef } from 'react'
import { PetAudioContourCanvas } from '../../components/ui'
import { ALPHA_CONTOUR_ANGLE_COUNT, buildOuterAlphaContour } from '../../../shared/alpha-contour'
import type { AlphaContour } from '../../../shared/alpha-contour'
import { readPetMusicSpectrum } from './pet-music-playback'

const MASK_WIDTH = 192
// The wave is animated every display frame; the silhouette is refreshed at
// 20 FPS so animated PNG and Live2D motion stays aligned without a full-size
// GPU readback on every frame.
const MASK_REFRESH_MS = 50

export function PetAudioContour({ sourceCanvasRef, readContour, geometry = 'content' }: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>
  readContour?: () => AlphaContour | null
  geometry?: 'content' | 'full'
}): React.JSX.Element {
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    const maskCanvas = document.createElement('canvas')
    const spectrum = new Uint8Array(ALPHA_CONTOUR_ANGLE_COUNT / 2)
    const smoothed = new Float32Array(ALPHA_CONTOUR_ANGLE_COUNT)
    let contour: AlphaContour | null = null
    let lastMaskAt = Number.NEGATIVE_INFINITY
    let animationId = 0

    const render = (now: number): void => {
      const source = sourceCanvasRef.current
      const bounds = source?.getBoundingClientRect()
      const context = overlay.getContext('2d', { willReadFrequently: true })
      if (source === null || bounds === undefined || bounds.width <= 0 || bounds.height <= 0 || context === null) {
        animationId = requestAnimationFrame(render)
        return
      }

      resizeOverlay(overlay, bounds)
      const pixelRatio = overlay.width / bounds.width
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, bounds.width, bounds.height)

      const hasAudio = readPetMusicSpectrum(spectrum)
      if (hasAudio && now - lastMaskAt >= MASK_REFRESH_MS) {
        lastMaskAt = now
        const nextContour = readContour === undefined
          ? captureAlphaContour(source, maskCanvas)
          : readContour()
        contour = nextContour ?? contour
      }
      if (hasAudio && contour !== null) drawAudioBars(context, contour, spectrum, smoothed, bounds.width, bounds.height)
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationId)
  }, [readContour, sourceCanvasRef])

  return <PetAudioContourCanvas ref={overlayRef} geometry={geometry} aria-hidden="true"/>
}

export function captureAlphaContour(source: HTMLCanvasElement, maskCanvas: HTMLCanvasElement): AlphaContour | null {
  const sourceWidth = source.width
  const sourceHeight = source.height
  if (sourceWidth <= 0 || sourceHeight <= 0) return null
  const maskHeight = Math.max(1, Math.round(MASK_WIDTH * sourceHeight / sourceWidth))
  maskCanvas.width = MASK_WIDTH
  maskCanvas.height = maskHeight
  const context = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.clearRect(0, 0, MASK_WIDTH, maskHeight)
  try {
    context.drawImage(source, 0, 0, MASK_WIDTH, maskHeight)
    const pixels = context.getImageData(0, 0, MASK_WIDTH, maskHeight).data
    return buildOuterAlphaContour(pixels, MASK_WIDTH, maskHeight)
  } catch (error) {
    console.error('[MusicContour] alpha capture failed', error)
    return null
  }
}

function resizeOverlay(canvas: HTMLCanvasElement, bounds: DOMRect): void {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, Math.round(bounds.width * pixelRatio))
  const height = Math.max(1, Math.round(bounds.height * pixelRatio))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function drawAudioBars(
  context: CanvasRenderingContext2D,
  contour: AlphaContour,
  spectrum: Uint8Array,
  smoothed: Float32Array,
  width: number,
  height: number
): void {
  const size = Math.min(width, height)
  const baseGap = size * 0.012
  const minimumLength = size * 0.015
  const waveRange = size * 0.065
  const centerX = contour.center.x * width
  const centerY = contour.center.y * height
  const bars = new Path2D()
  const pointStep = 4
  for (let index = 0; index < contour.points.length; index += pointStep) {
    const point = contour.points[index]!
    const previous = contour.points[(index - pointStep + contour.points.length) % contour.points.length]!
    const next = contour.points[(index + pointStep) % contour.points.length]!
    const x = point.x * width
    const y = point.y * height
    const tangentX = next.x * width - previous.x * width
    const tangentY = next.y * height - previous.y * height
    const tangentLength = Math.max(0.001, Math.hypot(tangentX, tangentY))
    let normalX = tangentY / tangentLength
    let normalY = -tangentX / tangentLength
    if (normalX * (x - centerX) + normalY * (y - centerY) < 0) {
      normalX *= -1
      normalY *= -1
    }
    const barIndex = Math.floor(index / pointStep)
    const bandIndex = Math.round(barIndex / (contour.points.length / pointStep - 1) * (spectrum.length - 1))
    const band = spectrum[bandIndex]! / 255
    smoothed[index] = smoothed[index]! * 0.68 + band * 0.32
    const barLength = minimumLength + smoothed[index]! * waveRange
    bars.moveTo(x + normalX * baseGap, y + normalY * baseGap)
    bars.lineTo(x + normalX * (baseGap + barLength), y + normalY * (baseGap + barLength))
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#6e8fff'
  context.save()
  context.lineCap = 'butt'
  context.strokeStyle = accent
  context.globalAlpha = 0.22
  context.lineWidth = Math.max(2.5, size * 0.009)
  context.shadowColor = accent
  context.shadowBlur = size * 0.012
  context.stroke(bars)
  context.globalAlpha = 0.96
  context.lineWidth = Math.max(1.4, size * 0.004)
  context.shadowBlur = size * 0.008
  context.stroke(bars)
  context.restore()
}
