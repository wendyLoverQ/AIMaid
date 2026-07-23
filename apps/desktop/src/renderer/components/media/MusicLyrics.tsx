export interface MusicLyricsProps {
  readonly title: string
  readonly current: string
  readonly next: string
  readonly anchorX: number
  readonly anchorTop: number
}

export function MusicLyrics({ title, current, next, anchorX, anchorTop }: MusicLyricsProps): React.JSX.Element {
  return <section className="pet-music-lyrics" style={{ left: anchorX, top: anchorTop }}
    aria-live="off" aria-label={`${title} 歌词`}>
    <p className="pet-music-lyrics__current">{current}</p>
    {next === '' ? null : <p className="pet-music-lyrics__next">{next}</p>}
  </section>
}
