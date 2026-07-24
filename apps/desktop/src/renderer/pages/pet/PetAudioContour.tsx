import { useEffect, useRef } from 'react'
import { PetAudioContourCanvas } from '../../components/ui'
import { ALPHA_CONTOUR_ANGLE_COUNT, buildOuterAlphaContour } from '../../../shared/alpha-contour'
import type { AlphaContour } from '../../../shared/alpha-contour'
import { advanceBarDynamics, barSpectrumTarget, spectrumPeak } from '../../../shared/audio-bar-dynamics'
import { bottomBarIdentity, bottomBarSlots, createBottomBarLayout, createRadialVisualizerLayout, isBackgroundMusicVisualizer } from '../../../shared/music-visualizer'
import type { BottomBarLayout, RadialVisualizerLayout } from '../../../shared/music-visualizer'
import type { MusicVisualizerStyle } from '../../../shared/music-visualizer'
import { readPetMusicSpectrum, readPetMusicWaveform } from './pet-music-playback'

const MASK_WIDTH = 160
const MASK_REFRESH_MS = 120
const CONTOUR_FOLLOW_TIME_MS = 150
const SURROUND_PADDING = 72
const BOTTOM_EXTENSION = 88
const RADIAL_EXTENSION = 72

export interface PetAudioAnchor { readonly clientX: number; readonly clientY: number }
export interface PetAudioAlphaTop { readonly clientX: number; readonly clientY: number }

export function PetAudioContour({ sourceCanvasRef, readContour, sourceKey, visualAnchor, onAlphaTop, visualizerStyle }: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>
  readContour?: (() => AlphaContour | null) | undefined
  sourceKey: string
  visualAnchor?: PetAudioAnchor | undefined
  visualizerStyle: MusicVisualizerStyle
  onAlphaTop?: ((anchor: PetAudioAlphaTop | null) => void) | undefined
}): React.JSX.Element {
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const visualAnchorRef = useRef<PetAudioAnchor | undefined>(visualAnchor)
  visualAnchorRef.current = visualAnchor

  useEffect(() => {
    const overlay = overlayRef.current
    if (overlay === null) return
    const maskCanvas = document.createElement('canvas')
    const context = overlay.getContext('2d')
    if (context === null) return
    const spectrum = new Uint8Array(ALPHA_CONTOUR_ANGLE_COUNT / 2)
    const waveform = new Uint8Array(ALPHA_CONTOUR_ANGLE_COUNT)
    const dynamics = new Map<number, number>()
    let contour: AlphaContour | null = null
    let smoothedContour: AlphaContour | null = null
    let lastMaskAt = Number.NEGATIVE_INFINITY
    let lastContourFrameAt = Number.NaN
    let animationId = 0
    let wasActive = false
    let bottomLayout: BottomBarLayout | null = null
    let radialLayout: RadialVisualizerLayout | null = null
    let lastAlphaTop: PetAudioAlphaTop | null = null
    let smoothedVisualAnchor: PetAudioAnchor | undefined

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
          smoothedContour = null
          lastContourFrameAt = Number.NaN
          smoothedVisualAnchor = undefined
          if (lastAlphaTop !== null) {
            lastAlphaTop = null
            onAlphaTop?.(null)
          }
        }
        animationId = requestAnimationFrame(render)
        return
      }
      wasActive = true
      overlay.hidden = false
      if (visualizerStyle === 'circular-wave') readPetMusicWaveform(waveform)
      if (hasAudio && now - lastMaskAt >= MASK_REFRESH_MS) {
        lastMaskAt = now
        const nextContour = readContour === undefined ? captureAlphaContour(source, maskCanvas) : readContour()
        contour = nextContour ?? contour
      }
      if (contour !== null) {
        if (smoothedContour === null) smoothedContour = contour
        const elapsed = Number.isNaN(lastContourFrameAt) ? 16 : Math.min(50, now - lastContourFrameAt)
        const follow = 1 - Math.exp(-elapsed / CONTOUR_FOLLOW_TIME_MS)
        smoothedContour = interpolateAlphaContour(smoothedContour, contour, follow)
        lastContourFrameAt = now
        const visualContour = smoothedContour
        const alphaTopPoint = contour.points.reduce((highest, point) => point.y < highest.y ? point : highest)
        const alphaTop: PetAudioAlphaTop = {
          clientX: sourceBounds.left + alphaTopPoint.x * sourceBounds.width,
          clientY: sourceBounds.top + alphaTopPoint.y * sourceBounds.height
        }
        if (lastAlphaTop === null || Math.abs(lastAlphaTop.clientX - alphaTop.clientX) >= 0.5 ||
          Math.abs(lastAlphaTop.clientY - alphaTop.clientY) >= 0.5) {
          lastAlphaTop = alphaTop
          onAlphaTop?.(alphaTop)
        }
        if (visualizerStyle === 'bottom-wave' && bottomLayout === null) {
          bottomLayout = createBottomBarLayout(visualContour, sourceBounds.width)
        }
        if (isBackgroundMusicVisualizer(visualizerStyle) && radialLayout === null) {
          radialLayout = createRadialVisualizerLayout(visualContour, sourceBounds.width, sourceBounds.height)
        }
        const targetAnchor = visualAnchorRef.current
        if (targetAnchor === undefined) {
          smoothedVisualAnchor = undefined
        } else if (smoothedVisualAnchor === undefined) {
          smoothedVisualAnchor = targetAnchor
        } else {
          smoothedVisualAnchor = interpolatePetAudioAnchor(smoothedVisualAnchor, targetAnchor, follow)
        }
        const anchor = smoothedVisualAnchor
        const region = radialLayout !== null
          ? positionRadialOverlay(overlay, sourceBounds, stageBounds, radialLayout, anchor)
          : visualizerStyle === 'bottom-wave' && bottomLayout !== null
            ? positionBottomOverlay(overlay, sourceBounds, stageBounds, visualContour, bottomLayout, anchor)
            : positionOverlay(overlay, sourceBounds, stageBounds, visualContour)
        resizeOverlay(overlay, region.width, region.height)
        const pixelRatio = overlay.width / region.width
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
        context.clearRect(0, 0, region.width, region.height)
        const x = sourceBounds.left - stageBounds.left - region.left
        const y = sourceBounds.top - stageBounds.top - region.top
        if (anchor === undefined) {
          delete overlay.dataset.visualAnchorX
          delete overlay.dataset.visualAnchorY
        } else {
          overlay.dataset.visualAnchorX = anchor.clientX.toFixed(2)
          overlay.dataset.visualAnchorY = anchor.clientY.toFixed(2)
        }
        if (visualizerStyle === 'bottom-wave' && bottomLayout !== null) drawBottomBars(context, visualContour, bottomLayout, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height,
          anchor === undefined ? undefined : anchor.clientX - stageBounds.left - region.left)
        else if (visualizerStyle === 'surround-line') drawSurroundWave(context, visualContour, spectrum, dynamics, x, y, sourceBounds.width, sourceBounds.height)
        else if (radialLayout !== null && isBackgroundMusicVisualizer(visualizerStyle)) drawBackgroundVisualizer(context, visualizerStyle, radialLayout, spectrum, waveform, dynamics, now,
          anchor?.clientX === undefined ? sourceBounds.left - stageBounds.left + radialLayout.normalizedCenterX * sourceBounds.width - region.left : anchor.clientX - stageBounds.left - region.left,
          anchor?.clientY === undefined ? sourceBounds.top - stageBounds.top + radialLayout.normalizedCenterY * sourceBounds.height - region.top : anchor.clientY - stageBounds.top - region.top)
      }
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(animationId)
      onAlphaTop?.(null)
    }
  }, [onAlphaTop, readContour, sourceCanvasRef, sourceKey, visualizerStyle])

  return <PetAudioContourCanvas ref={overlayRef} geometry="full" data-visualizer-style={visualizerStyle}
    data-visualizer-layer={isBackgroundMusicVisualizer(visualizerStyle) ? 'background' : 'foreground'} aria-hidden="true" hidden/>
}

function interpolateAlphaContour(current: AlphaContour, target: AlphaContour, amount: number): AlphaContour {
  return {
    center: {
      x: current.center.x + (target.center.x - current.center.x) * amount,
      y: current.center.y + (target.center.y - current.center.y) * amount
    },
    points: current.points.map((point, index) => {
      const targetPoint = target.points[index] ?? point
      return {
        x: point.x + (targetPoint.x - point.x) * amount,
        y: point.y + (targetPoint.y - point.y) * amount
      }
    })
  }
}

function interpolatePetAudioAnchor(current: PetAudioAnchor, target: PetAudioAnchor, amount: number): PetAudioAnchor {
  return {
    clientX: current.clientX + (target.clientX - current.clientX) * amount,
    clientY: current.clientY + (target.clientY - current.clientY) * amount
  }
}

interface OverlayRegion { left: number; top: number; width: number; height: number }

function positionOverlay(
  overlay: HTMLCanvasElement,
  source: DOMRect,
  stage: DOMRect,
  contour: AlphaContour
): OverlayRegion {
  const contourLeft = Math.min(...contour.points.map((point) => point.x))
  const contourRight = Math.max(...contour.points.map((point) => point.x))
  const contourTop = Math.min(...contour.points.map((point) => point.y))
  const contourBottom = Math.max(...contour.points.map((point) => point.y))
  const desiredLeft = source.left - stage.left + contourLeft * source.width - SURROUND_PADDING
  const desiredTop = source.top - stage.top + contourTop * source.height - SURROUND_PADDING
  const desiredRight = source.left - stage.left + contourRight * source.width + SURROUND_PADDING
  const desiredBottom = source.top - stage.top + contourBottom * source.height + SURROUND_PADDING
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

function positionBottomOverlay(
  overlay: HTMLCanvasElement,
  source: DOMRect,
  stage: DOMRect,
  contour: AlphaContour,
  layout: BottomBarLayout,
  anchor: PetAudioAnchor | undefined
): OverlayRegion {
  const contourLeft = Math.min(...contour.points.map((point) => point.x))
  const contourRight = Math.max(...contour.points.map((point) => point.x))
  const contourBottom = Math.max(...contour.points.map((point) => point.y))
  const visibleWidth = Math.max(layout.spacing * 2, (contourRight - contourLeft) * source.width)
  const centerX = anchor === undefined
    ? source.left - stage.left + layout.normalizedCenterX * source.width
    : anchor.clientX - stage.left
  const baseline = source.top - stage.top + contourBottom * source.height + 8
  const left = Math.max(0, Math.floor(centerX - visibleWidth / 2 - 12))
  const top = Math.max(0, Math.floor(baseline - 12))
  const right = Math.min(stage.width, Math.ceil(centerX + visibleWidth / 2 + 12))
  const bottom = Math.min(stage.height, Math.ceil(baseline + BOTTOM_EXTENSION))
  const region = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  overlay.style.inset = 'auto'
  overlay.style.left = `${region.left}px`
  overlay.style.top = `${region.top}px`
  overlay.style.width = `${region.width}px`
  overlay.style.height = `${region.height}px`
  return region
}

function positionRadialOverlay(
  overlay: HTMLCanvasElement,
  source: DOMRect,
  stage: DOMRect,
  layout: RadialVisualizerLayout,
  anchor: PetAudioAnchor | undefined
): OverlayRegion {
  const centerX = anchor === undefined ? source.left - stage.left + layout.normalizedCenterX * source.width : anchor.clientX - stage.left
  const centerY = anchor === undefined ? source.top - stage.top + layout.normalizedCenterY * source.height : anchor.clientY - stage.top
  const extent = layout.radius + RADIAL_EXTENSION
  const left = Math.max(0, Math.floor(centerX - extent))
  const top = Math.max(0, Math.floor(centerY - extent))
  const right = Math.min(stage.width, Math.ceil(centerX + extent))
  const bottom = Math.min(stage.height, Math.ceil(centerY + extent))
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
  height: number
): void {
  const centerX = offsetX + contour.center.x * width
  const centerY = offsetY + contour.center.y * height
  const points = contour.points.map((point) => ({ x: offsetX + point.x * width, y: offsetY + point.y * height }))
  const segments = points.map((point, index) => {
    const next = points[(index + 1) % points.length]!
    return { start: point, end: next, length: Math.hypot(next.x - point.x, next.y - point.y) }
  })
  const perimeter = segments.reduce((sum, segment) => sum + segment.length, 0)
  const spacing = 7
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
    const displacement = 7 + level * 22
    const targetX = x + normalX * displacement
    const targetY = y + normalY * displacement
    if (barIndex === 0) path.moveTo(targetX, targetY)
    else path.lineTo(targetX, targetY)
    barIndex += 1
  }
  path.closePath()
  trimDynamics(dynamics, barIndex)
  strokeVisualizer(context, path, 5, 2.5)
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
  height: number,
  centerXOverride?: number
): void {
  const contourBottom = Math.max(...contour.points.map((point) => point.y))
  const center = centerXOverride ?? offsetX + layout.normalizedCenterX * width
  const slots = bottomBarSlots(contour, width, layout.spacing)
  const baseline = snapToDevicePixel(context, offsetY + contourBottom * height + 8)
  const peak = spectrumPeak(spectrum)
  const path = new Path2D()
  for (const slot of slots) {
    const identity = bottomBarIdentity(slot)
    const target = barSpectrumTarget(spectrum, peak, identity)
    const level = advanceBarDynamics(dynamics.get(identity) ?? 0, target, identity)
    dynamics.set(identity, level)
    const x = snapToDevicePixel(context, center + slot * layout.spacing)
    const length = 10 + level * 58
    path.moveTo(x, baseline)
    path.lineTo(x, snapToDevicePixel(context, baseline + length))
  }
  strokeVisualizer(context, path, 6, 6)
}

function drawBackgroundVisualizer(
  context: CanvasRenderingContext2D,
  style: Exclude<MusicVisualizerStyle, 'surround-line' | 'bottom-wave'>,
  layout: RadialVisualizerLayout,
  spectrum: Uint8Array,
  waveform: Uint8Array,
  dynamics: Map<number, number>,
  now: number,
  centerX: number,
  centerY: number
): void {
  if (style === 'radial-bars') {
    drawRadialBars(context, layout.radius, spectrum, dynamics, centerX, centerY)
    return
  }
  if (style === 'circular-wave') {
    drawCircularWave(context, layout.radius, waveform, centerX, centerY)
    return
  }
  drawPulseRings(context, layout.radius, spectrum, dynamics, now, centerX, centerY)
}

function drawRadialBars(
  context: CanvasRenderingContext2D,
  radius: number,
  spectrum: Uint8Array,
  dynamics: Map<number, number>,
  centerX: number,
  centerY: number
): void {
  const count = 72
  const peak = spectrumPeak(spectrum)
  const path = new Path2D()
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + index / count * Math.PI * 2
    const target = barSpectrumTarget(spectrum, peak, index)
    const level = advanceBarDynamics(dynamics.get(index) ?? 0, target, index)
    dynamics.set(index, level)
    const halfLength = 5 + level * 23
    path.moveTo(centerX + Math.cos(angle) * (radius - halfLength), centerY + Math.sin(angle) * (radius - halfLength))
    path.lineTo(centerX + Math.cos(angle) * (radius + halfLength), centerY + Math.sin(angle) * (radius + halfLength))
  }
  trimDynamics(dynamics, count)
  strokeVisualizer(context, path, 7, 4)
}

function drawCircularWave(
  context: CanvasRenderingContext2D,
  radius: number,
  waveform: Uint8Array,
  centerX: number,
  centerY: number
): void {
  const path = new Path2D()
  for (let index = 0; index < waveform.length; index += 1) {
    const angle = -Math.PI / 2 + index / waveform.length * Math.PI * 2
    const displacement = ((waveform[index]! - 128) / 128) * 28
    const pointRadius = radius + displacement
    const x = centerX + Math.cos(angle) * pointRadius
    const y = centerY + Math.sin(angle) * pointRadius
    if (index === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  }
  path.closePath()
  strokeVisualizer(context, path, 6, 3)
}

function drawPulseRings(
  context: CanvasRenderingContext2D,
  radius: number,
  spectrum: Uint8Array,
  dynamics: Map<number, number>,
  now: number,
  centerX: number,
  centerY: number
): void {
  const bassBins = Math.min(12, spectrum.length)
  let bass = 0
  for (let index = 0; index < bassBins; index += 1) bass += spectrum[index]!
  const target = bassBins === 0 ? 0 : bass / bassBins / 255
  const level = advanceBarDynamics(dynamics.get(0) ?? 0, target, 0)
  dynamics.set(0, level)
  const phase = now / 1500 % 1
  for (let index = 0; index < 3; index += 1) {
    const progress = (phase + index / 3) % 1
    const ring = new Path2D()
    ring.arc(centerX, centerY, radius + progress * (38 + level * 24), 0, Math.PI * 2)
    strokeAccent(context, ring, 3.5 - progress * 1.5, (1 - progress) * (0.2 + level * 0.58))
  }
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
  if (glowWidth > lineWidth) {
    context.globalAlpha = 0.14
    context.lineWidth = glowWidth
    context.shadowColor = accent
    context.shadowBlur = 4
    context.stroke(path)
  }
  context.globalAlpha = 1
  context.lineWidth = lineWidth
  context.shadowColor = 'transparent'
  context.shadowBlur = 0
  context.stroke(path)
  context.restore()
}

function strokeAccent(context: CanvasRenderingContext2D, path: Path2D, lineWidth: number, alpha: number): void {
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  if (accent === '') return
  context.save()
  context.strokeStyle = accent
  context.globalAlpha = alpha
  context.lineWidth = lineWidth
  context.shadowBlur = 0
  context.stroke(path)
  context.restore()
}

function snapToDevicePixel(context: CanvasRenderingContext2D, value: number): number {
  const ratio = Math.max(1, context.getTransform().a)
  return Math.round(value * ratio) / ratio
}
