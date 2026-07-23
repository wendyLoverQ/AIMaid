export interface MusicLyricsProps {
  readonly title: string
  readonly current: string
  readonly next: string
}

export function MusicLyrics({ title, current, next }: MusicLyricsProps): React.JSX.Element {
  return <section className="pet-music-lyrics" aria-live="off" aria-label={`${title} 歌词`}>
    <p className="pet-music-lyrics__current">{current}</p>
    {next === '' ? null : <p className="pet-music-lyrics__next">{next}</p>}
  </section>
}
