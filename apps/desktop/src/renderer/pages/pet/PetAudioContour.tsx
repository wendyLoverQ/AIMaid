import { useEffect, useRef } from 'react'
import { PetAudioContourCanvas } from '../../components/ui'
import { ALPHA_CONTOUR_ANGLE_COUNT, buildOuterAlphaContour } from '../../../shared/alpha-contour'
import type { AlphaContour } from '../../../shared/alpha-contour'
import { advanceBarDynamics, barSpectrumTarget, spectrumPeak } from '../../../shared/audio-bar-dynamics'
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer'
import { readPetMusicSpectrum } from './pet-music-playback'

const MASK_WIDTH = 192
const MASK_REFRESH_MS = 50

export function PetAudioContour({ sourceCanvasRef, readContour, visualizerStyle }: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>
  readContour?: (() => AlphaContour | null) | undefined
  visualizerStyle: MusicVisualizerStyle
}): React.JSX.Element {
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    const maskCanvas = document.createElement('canvas')
    const spectrum = new Uint8Array(ALPHA_CONTOUR_ANGLE_COUNT / 2)
    const dynamics = new Map<number, number>()
    let contour: AlphaContour | null = null
    let lastMaskAt = Number.NEGATIVE_INFINITY
    let animationId = 0

    const render = (now: number): void => {
      const source = sourceCanvasRef.current
      const sourceBounds = source?.getBoundingClientRect()
      const overlayBounds = overlay.getBoundingClientRect()
      const context = overlay.getContext('2d', { willReadFrequently: true })
      if (source === null || sourceBounds === undefined || sourceBounds.width <= 0 || sourceBounds.height <= 0 ||
        overlayBounds.width <= 0 || overlayBounds.height <= 0 || context === null) {
        animationId = requestAnimationFrame(render)
        return
      }

      resizeOverlay(overlay, overlayBounds.width, overlayBounds.height)
      const pixelRatio = overlay.width / overlayBounds.width
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, overlayBounds.width, overlayBounds.height)

      const hasAudio = readPetMusicSpectrum(spectrum)
      if (hasAudio && now - lastMaskAt >= MASK_REFRESH_MS) {
        lastMaskAt = now
        const nextContour = readContour === undefined ? captureAlphaContour(source, maskCanvas) : readContour()
        contour = nextContour ?? contour
      }
      if (hasAudio) {
        const x = sourceBounds.left - overlayBounds.left
        const y = sourceBounds.top - overlayBounds.top
        if (visualizerStyle === 'bottom-wave' && contour !== null) drawBottomBars(context, contour, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height)
        else if (visualizerStyle !== 'bottom-wave' && contour !== null) drawSurroundWave(context, contour, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height, visualizerStyle)
      }
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationId)
  }, [readContour, sourceCanvasRef, visualizerStyle])

  return <PetAudioContourCanvas ref={overlayRef} geometry="full" data-visualizer-style={visualizerStyle} aria-hidden="true"/>
}

export function captureAlphaContour(source: HTMLCanvasElement, maskCanvas: HTMLCanvasElement): AlphaContour | null {
  if (source.width <= 0 || source.height <= 0) return null
  const maskHeight = Math.max(1, Math.round(MASK_WIDTH * source.height / source.width))
  maskCanvas.width = MASK_WIDTH
  maskCanvas.height = maskHeight
  const context = maskCanvas.getContext('2d', { willReadFrequently: true })
  if (context === null) return null
  context.clearRect(0, 0, MASK_WIDTH, maskHeight)
  try {
    context.drawImage(source, 0, 0, MASK_WIDTH, maskHeight)
    return buildOuterAlphaContour(context.getImageData(0, 0, MASK_WIDTH, maskHeight).data, MASK_WIDTH, maskHeight)
  } catch (error) {
    console.error('[MusicContour] alpha capture failed', error)
    return null
  }
}

function resizeOverlay(canvas: HTMLCanvasElement, width: number, height: number): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const pixelWidth = Math.max(1, Math.round(width * ratio))
  const pixelHeight = Math.max(1, Math.round(height * ratio))
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
}

function drawSurroundWave(
  context: CanvasRenderingContext2D,
  contour: AlphaContour,
  spectrum: Uint8Array,
  dynamics: Map<number, number>,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number,
  style: Exclude<MusicVisualizerStyle, 'bottom-wave'>
): void {
  const centerX = offsetX + contour.center.x * width
  const centerY = offsetY + contour.center.y * height
  const points = contour.points.map((point) => ({ x: offsetX + point.x * width, y: offsetY + point.y * height }))
  const segments = points.map((point, index) => {
    const next = points[(index + 1) % points.length]!
    return { start: point, end: next, length: Math.hypot(next.x - point.x, next.y - point.y) }
  })
  const perimeter = segments.reduce((sum, segment) => sum + segment.length, 0)
  const spacing = style === 'surround-bars' ? 10 : 7
  const peak = spectrumPeak(spectrum)
  const path = new Path2D()
  let segmentIndex = 0
  let segmentStart = 0
  let barIndex = 0
  for (let distance = 0; distance < perimeter; distance += spacing) {
    while (segmentIndex < segments.length - 1 && distance > segmentStart + segments[segmentIndex]!.length) {
      segmentStart += segments[segmentIndex]!.length
      segmentIndex += 1
    }
    const segment = segments[segmentIndex]!
    if (segment.length <= 0.001) continue
    const progress = Math.min(1, (distance - segmentStart) / segment.length)
    const x = segment.start.x + (segment.end.x - segment.start.x) * progress
    const y = segment.start.y + (segment.end.y - segment.start.y) * progress
    const tangentX = (segment.end.x - segment.start.x) / segment.length
    const tangentY = (segment.end.y - segment.start.y) / segment.length
    let normalX = tangentY
    let normalY = -tangentX
    if (normalX * (x - centerX) + normalY * (y - centerY) < 0) { normalX *= -1; normalY *= -1 }
    const target = barSpectrumTarget(spectrum, peak, barIndex)
    const level = advanceBarDynamics(dynamics.get(barIndex) ?? 0, target, barIndex)
    dynamics.set(barIndex, level)
    if (style === 'surround-bars') {
      const length = 7 + level * 48
      path.moveTo(x + normalX * 7, y + normalY * 7)
      path.lineTo(x + normalX * (7 + length), y + normalY * (7 + length))
    } else {
      const displacement = 7 + level * 22
      const targetX = x + normalX * displacement
      const targetY = y + normalY * displacement
      if (barIndex === 0) path.moveTo(targetX, targetY)
      else path.lineTo(targetX, targetY)
    }
    barIndex += 1
  }
  if (style === 'surround-line') path.closePath()
  trimDynamics(dynamics, barIndex)
  strokeVisualizer(context, path, style === 'surround-bars' ? 8 : 5, style === 'surround-bars' ? 4 : 2.5)
}

function drawBottomBars(
  context: CanvasRenderingContext2D,
  contour: AlphaContour,
  spectrum: Uint8Array,
  dynamics: Map<number, number>,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number
): void {
  const contourLeft = Math.min(...contour.points.map((point) => point.x))
  const contourRight = Math.max(...contour.points.map((point) => point.x))
  const contourBottom = Math.max(...contour.points.map((point) => point.y))
  const left = offsetX + contourLeft * width
  const usableWidth = Math.max(1, (contourRight - contourLeft) * width)
  const spacing = 14
  const count = Math.max(8, Math.floor(usableWidth / spacing))
  const baseline = offsetY + contourBottom * height + 8
  const peak = spectrumPeak(spectrum)
  const path = new Path2D()
  for (let index = 0; index < count; index += 1) {
    const target = barSpectrumTarget(spectrum, peak, index)
    const level = advanceBarDynamics(dynamics.get(index) ?? 0, target, index)
    dynamics.set(index, level)
    const x = left + index / Math.max(1, count - 1) * usableWidth
    const length = 10 + level * 58
    path.moveTo(x, baseline)
    path.lineTo(x, baseline + length)
  }
  trimDynamics(dynamics, count)
  strokeVisualizer(context, path, 10, 6)
}

function trimDynamics(dynamics: Map<number, number>, count: number): void {
  for (const index of dynamics.keys()) if (index >= count) dynamics.delete(index)
}

function strokeVisualizer(context: CanvasRenderingContext2D, path: Path2D, glowWidth: number, lineWidth: number): void {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  if (accent === '') return
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = accent
  context.globalAlpha = 0.22
  context.lineWidth = glowWidth
  context.shadowColor = accent
  context.shadowBlur = 8
  context.stroke(path)
  context.globalAlpha = 0.96
  context.lineWidth = lineWidth
  context.shadowBlur = 5
  context.stroke(path)
  context.restore()
}
