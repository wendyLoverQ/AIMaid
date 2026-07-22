import { useEffect, useRef } from 'react'
import { PetAudioContourCanvas } from '../../components/ui'
import { ALPHA_CONTOUR_ANGLE_COUNT, buildOuterAlphaContour } from '../../../shared/alpha-contour'
import type { AlphaContour } from '../../../shared/alpha-contour'
import { advanceBarDynamics, barSpectrumTarget, spectrumPeak } from '../../../shared/audio-bar-dynamics'
import { bottomBarIdentity, bottomBarSlots, createBottomBarLayout } from '../../../shared/music-visualizer'
import type { BottomBarLayout } from '../../../shared/music-visualizer'
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer'
import { readPetMusicSpectrum } from './pet-music-playback'

const MASK_WIDTH = 160
const MASK_REFRESH_MS = 120
const SURROUND_PADDING = 72
const BOTTOM_EXTENSION = 88

export function PetAudioContour({ sourceCanvasRef, readContour, sourceKey, visualizerStyle }: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>
  readContour?: (() => AlphaContour | null) | undefined
  sourceKey: string
  visualizerStyle: MusicVisualizerStyle
}): React.JSX.Element {
  const overlayRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    const maskCanvas = document.createElement('canvas')
    const context = overlay.getContext('2d')
    if (context === null) return
    const spectrum = new Uint8Array(ALPHA_CONTOUR_ANGLE_COUNT / 2)
    const dynamics = new Map<number, number>()
    let contour: AlphaContour | null = null
    let lastMaskAt = Number.NEGATIVE_INFINITY
    let animationId = 0
    let wasActive = false
    let bottomLayout: BottomBarLayout | null = null

    const render = (now: number): void => {
      const source = sourceCanvasRef.current
      const sourceBounds = source?.getBoundingClientRect()
      const stageBounds = overlay.parentElement?.getBoundingClientRect()
      if (source === null || sourceBounds === undefined || sourceBounds.width <= 0 || sourceBounds.height <= 0 ||
        stageBounds === undefined || stageBounds.width <= 0 || stageBounds.height <= 0) {
        animationId = requestAnimationFrame(render)
        return
      }

      const hasAudio = readPetMusicSpectrum(spectrum)
      if (!hasAudio) {
        if (wasActive) {
          context.resetTransform()
          context.clearRect(0, 0, overlay.width, overlay.height)
          overlay.hidden = true
          wasActive = false
        }
        animationId = requestAnimationFrame(render)
        return
      }
      wasActive = true
      overlay.hidden = false
      if (hasAudio && now - lastMaskAt >= MASK_REFRESH_MS) {
        lastMaskAt = now
        const nextContour = readContour === undefined ? captureAlphaContour(source, maskCanvas) : readContour()
        contour = nextContour ?? contour
      }
      if (contour !== null) {
        if (visualizerStyle === 'bottom-wave' && bottomLayout === null) {
          bottomLayout = createBottomBarLayout(contour, sourceBounds.width)
        }
        const region = positionOverlay(overlay, sourceBounds, stageBounds, visualizerStyle)
        resizeOverlay(overlay, region.width, region.height)
        const pixelRatio = overlay.width / region.width
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
        context.clearRect(0, 0, region.width, region.height)
        const x = sourceBounds.left - stageBounds.left - region.left
        const y = sourceBounds.top - stageBounds.top - region.top
        if (visualizerStyle === 'bottom-wave' && bottomLayout !== null) drawBottomBars(context, contour, bottomLayout, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height)
        else if (visualizerStyle !== 'bottom-wave' && contour !== null) drawSurroundWave(context, contour, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height, visualizerStyle)
      }
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationId)
  }, [readContour, sourceCanvasRef, sourceKey, visualizerStyle])

  return <PetAudioContourCanvas ref={overlayRef} geometry="full" data-visualizer-style={visualizerStyle} aria-hidden="true" hidden/>
}

interface OverlayRegion { left: number; top: number; width: number; height: number }

function positionOverlay(
  overlay: HTMLCanvasElement,
  source: DOMRect,
  stage: DOMRect,
  style: MusicVisualizerStyle
): OverlayRegion {
  const padding = style === 'bottom-wave' ? 0 : SURROUND_PADDING
  const extension = style === 'bottom-wave' ? BOTTOM_EXTENSION : SURROUND_PADDING
  const desiredLeft = source.left - stage.left - padding
  const desiredTop = source.top - stage.top - padding
  const desiredRight = source.right - stage.left + padding
  const desiredBottom = source.bottom - stage.top + extension
  const left = Math.max(0, Math.floor(desiredLeft))
  const top = Math.max(0, Math.floor(desiredTop))
  const right = Math.min(stage.width, Math.ceil(desiredRight))
  const bottom = Math.min(stage.height, Math.ceil(desiredBottom))
  const region = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  overlay.style.inset = 'auto'
  overlay.style.left = `${region.left}px`
  overlay.style.top = `${region.top}px`
  overlay.style.width = `${region.width}px`
  overlay.style.height = `${region.height}px`
  return region
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
  layout: BottomBarLayout,
  spectrum: Uint8Array,
  dynamics: Map<number, number>,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number
): void {
  const contourBottom = Math.max(...contour.points.map((point) => point.y))
  const center = offsetX + layout.normalizedCenterX * width
  const slots = bottomBarSlots(contour, width, layout.spacing)
  const baseline = offsetY + contourBottom * height + 8
  const peak = spectrumPeak(spectrum)
  const path = new Path2D()
  for (const slot of slots) {
    const identity = bottomBarIdentity(slot)
    const target = barSpectrumTarget(spectrum, peak, identity)
    const level = advanceBarDynamics(dynamics.get(identity) ?? 0, target, identity)
    dynamics.set(identity, level)
    const x = center + slot * layout.spacing
    const length = 10 + level * 58
    path.moveTo(x, baseline)
    path.lineTo(x, baseline + length)
  }
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
