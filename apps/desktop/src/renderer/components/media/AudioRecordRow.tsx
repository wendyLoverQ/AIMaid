import type { ReactNode } from 'react'
import { AudioPlayer } from './MediaPlayer'
import { Avatar } from '../data/Avatar'
export interface AudioRecordRowProps { name: string; source: string; time?: string; transcript?: string; status?: ReactNode; actions?: ReactNode }
export function AudioRecordRow({ name, source, time, transcript, status, actions }: AudioRecordRowProps): React.JSX.Element {
  return <article className="ui-audio-record"><Avatar fallback={name.slice(0, 1)}/><div><header><strong>{name}</strong>{time !== undefined ? <time>{time}</time> : null}{status}</header><AudioPlayer source={source}/>{transcript !== undefined ? <p>{transcript}</p> : null}</div>{actions}</article>
}
