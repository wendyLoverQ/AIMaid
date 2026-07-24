import { IconButton } from '../base/IconButton'
import { UiIcon } from '../base/UiIcon'
import { Text } from '../layout/Primitives'

export interface TrayMusicPlayerProps {
  title: string
  singer: string
  paused: boolean
  hasNext: boolean
  onTogglePause: () => void
  onNext: () => void
  onStop: () => void
}

export function TrayMusicPlayer({ title, singer, paused, hasNext, onTogglePause, onNext, onStop }: TrayMusicPlayerProps): React.JSX.Element {
  return <section className="ui-tray-music-player" aria-label="音乐播放器">
    <div className="ui-tray-music-player__copy">
      <Text size="sm" wrap>{title}</Text>
      {singer === '' ? null : <Text size="xs" tone="secondary" wrap>{singer}</Text>}
    </div>
    <div className="ui-tray-music-player__controls" role="group" aria-label="播放控制">
      <IconButton
        label={paused ? '继续播放' : '暂停'}
        size="sm"
        className="ui-tray-music-player__control ui-tray-music-player__control--primary"
        onClick={onTogglePause}
      >
        <UiIcon name={paused ? 'play' : 'pause'} />
      </IconButton>
      {hasNext ? <IconButton
        label="下一曲"
        size="sm"
        className="ui-tray-music-player__control"
        onClick={onNext}
      >
        <UiIcon name="next" />
      </IconButton> : null}
      <IconButton
        label="停止"
        size="sm"
        className="ui-tray-music-player__control"
        onClick={onStop}
      >
        <UiIcon name="stop" />
      </IconButton>
    </div>
  </section>
}
