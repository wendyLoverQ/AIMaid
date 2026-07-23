export interface MusicLyricsProps {
  readonly title: string
  readonly current: string
  readonly anchorX: number
  readonly anchorTop: number
}

export function MusicLyrics({ title, current, anchorX, anchorTop }: MusicLyricsProps): React.JSX.Element {
  return <section className="pet-music-lyrics" style={{ left: anchorX, top: anchorTop }}
    aria-live="off" aria-label={`${title} 歌词`}>
    <p className="pet-music-lyrics__current">{current}</p>
  </section>
}
