import { useEffect, useRef } from 'react'

const LYRICS_FOLLOW_TIME_MS = 150

export interface MusicLyricsProps {
  readonly title: string
  readonly current: string
  readonly anchorX: number
  readonly anchorTop: number
}

export function MusicLyrics({ title, current, anchorX, anchorTop }: MusicLyricsProps): React.JSX.Element {
  const initialAnchor = useRef({ left: anchorX, top: anchorTop })
  const targetAnchor = useRef(initialAnchor.current)
  const currentAnchor = useRef<{ left: number; top: number } | null>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  targetAnchor.current = { left: anchorX, top: anchorTop }

  useEffect(() => {
    const surface = surfaceRef.current
    if (surface === null) return
    let animationId = 0
    let lastFrameAt = Number.NaN

    const updateAnchor = (now: number): void => {
      const target = targetAnchor.current
      const current = currentAnchor.current ??= { ...target }
      const elapsed = Number.isNaN(lastFrameAt) ? 16 : Math.min(50, now - lastFrameAt)
      const follow = 1 - Math.exp(-elapsed / LYRICS_FOLLOW_TIME_MS)
      current.left += (target.left - current.left) * follow
      current.top += (target.top - current.top) * follow
      surface.style.left = `${current.left.toFixed(2)}px`
      surface.style.top = `${current.top.toFixed(2)}px`
      lastFrameAt = now
      animationId = requestAnimationFrame(updateAnchor)
    }

    animationId = requestAnimationFrame(updateAnchor)
    return () => cancelAnimationFrame(animationId)
  }, [])

  return <section ref={surfaceRef} className="pet-music-lyrics"
    style={{ left: initialAnchor.current.left, top: initialAnchor.current.top }}
    aria-live="off" aria-label={`${title} 歌词`}>
    <p className="pet-music-lyrics__current">{current}</p>
  </section>
}
