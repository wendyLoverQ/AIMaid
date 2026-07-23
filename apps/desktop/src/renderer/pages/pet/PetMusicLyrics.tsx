import { useEffect, useState } from 'react'
import { MusicLyrics } from '../../components/ui'
import { subscribePetMusicLyrics } from './pet-music-playback'
import type { PetMusicLyricsSnapshot } from './pet-music-playback'

export function PetMusicLyrics({ anchorX, anchorTop }: {
  anchorX: number
  anchorTop: number
}): React.JSX.Element | null {
  const [lyrics, setLyrics] = useState<PetMusicLyricsSnapshot | null>(null)

  useEffect(() => subscribePetMusicLyrics(setLyrics), [])

  if (lyrics === null) return null
  return <MusicLyrics title={lyrics.title} current={lyrics.current} next={lyrics.next}
    anchorX={anchorX} anchorTop={anchorTop}/>
}
