import { forwardRef } from 'react'
import type { AudioHTMLAttributes, VideoHTMLAttributes } from 'react'

type BaseMediaProps = { source: string; autoPlay?: boolean; controls?: boolean; loop?: boolean; muted?: boolean }

export const AudioPlayer = forwardRef<HTMLAudioElement, BaseMediaProps & Omit<AudioHTMLAttributes<HTMLAudioElement>, 'src' | 'className' | 'style'>>(function AudioPlayer({ source, controls = true, ...props }, ref) {
  return <audio ref={ref} className="ui-audio-player" src={source} controls={controls} {...props} />
})

export const VideoPlayer = forwardRef<HTMLVideoElement, BaseMediaProps & Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src' | 'className' | 'style'>>(function VideoPlayer({ source, controls = true, ...props }, ref) {
  return <video ref={ref} className="ui-video-player" src={source} controls={controls} {...props} />
})
