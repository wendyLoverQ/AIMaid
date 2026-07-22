import { useEffect } from 'react'
import type { PetBubbleMessage } from '../../../shared/pet-bubble'
import { Paragraph, PetBubbleSurface } from '../../components/ui'

const MAX_VISIBLE_MS = 60_000
const AFTER_SPEECH_VISIBLE_MS = 5_000

export interface PetBubbleProps {
  message: PetBubbleMessage | null
  speechHeld: boolean
  onExpired: (nonce: string) => void
}

export function PetBubble({ message, speechHeld, onExpired }: PetBubbleProps): React.JSX.Element | null {
  useEffect(() => {
    if (message === null) return
    const remaining = Math.max(0, message.createdAt + MAX_VISIBLE_MS - Date.now())
    const timer = window.setTimeout(() => onExpired(message.nonce), remaining)
    return () => window.clearTimeout(timer)
  }, [message, onExpired])

  useEffect(() => {
    if (message === null || speechHeld) return
    const delay = message.kind === 'speech'
      ? AFTER_SPEECH_VISIBLE_MS
      : bubbleDisplayDurationMs(message.text)
    const timer = window.setTimeout(() => onExpired(message.nonce), delay)
    return () => window.clearTimeout(timer)
  }, [message, onExpired, speechHeld])

  if (message === null || message.text.trim() === '') return null
  return <PetBubbleSurface
    role="status"
    aria-live={message.kind === 'error' || message.kind === 'reminder' ? 'assertive' : 'polite'}
    data-kind={message.kind}
    onClick={() => onExpired(message.nonce)}
  >
    <Paragraph>{message.text}</Paragraph>
  </PetBubbleSurface>
}

export function bubbleDisplayDurationMs(text: string): number {
  return Math.min(20_000, 3_500 + Array.from(text).length * 70)
}
