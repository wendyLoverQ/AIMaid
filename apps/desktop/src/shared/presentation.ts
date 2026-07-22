import type { IpcResponseEnvelope } from './ipc'

export const PET_DISPLAY_MODES = ['image', 'png-sequence', 'live2d'] as const
export type PetDisplayMode = (typeof PET_DISPLAY_MODES)[number]

export type PetPresentationAction =
  | 'toggle-pause'
  | 'cycle-mode'
  | 'next-image'
  | 'cycle-image-interval'
  | 'choose-image-folder'
  | 'cycle-image-folder'
  | 'cycle-png-fps'
  | 'cycle-png-role'
  | 'toggle-png-carousel'
  | 'switch-live2d-role'

export interface PetMediaItem {
  name: string
  url: string
}

export interface PetPresentationSnapshot {
  mode: PetDisplayMode
  paused: boolean
  imageRoot: string
  imageFolder: string
  imageFolderName: string
  imageIntervalSeconds: number
  currentImage: PetMediaItem | null
  pngRoot: string
  pngRole: string
  pngSourceFps: number
  pngFps: number
  pngCarousel: boolean
  pngFrames: PetMediaItem[]
  pngRoles: string[]
  live2dRole: string
  live2dRoles: string[]
}

export interface PetPresentationApi {
  get: () => Promise<IpcResponseEnvelope<PetPresentationSnapshot>>
  execute: (action: PetPresentationAction) => Promise<IpcResponseEnvelope<PetPresentationSnapshot>>
}

export function isPetPresentationAction(value: unknown): value is PetPresentationAction {
  return typeof value === 'string' && [
    'toggle-pause', 'cycle-mode', 'next-image', 'cycle-image-interval', 'choose-image-folder', 'cycle-image-folder',
    'cycle-png-fps', 'cycle-png-role', 'toggle-png-carousel', 'switch-live2d-role'
  ].includes(value)
}
