import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PET_BUBBLE_HOLD_STORAGE_KEY,
  PET_BUBBLE_STORAGE_KEY,
  canInterruptPetBubble,
  createPetBubbleMessage,
  isPetBubbleKind,
  selectNextPetBubble,
  type PetBubbleKind,
  type PetBubbleMessage,
  type PetBubblePayload
} from '../../../shared/pet-bubble'

export interface PetBubbleQueue {
  current: PetBubbleMessage | null
  speechHeld: boolean
  show: (text: string, kind: PetBubbleKind, nonce?: string) => void
  expire: (nonce: string) => void
}

export function usePetBubbleQueue(): PetBubbleQueue {
  const [current, setCurrentState] = useState<PetBubbleMessage | null>(null)
  const [speechHeld, setSpeechHeldState] = useState(false)
  const currentRef = useRef<PetBubbleMessage | null>(null)
  const pendingRef = useRef<PetBubbleMessage[]>([])
  const speechHeldRef = useRef(false)

  const setCurrent = useCallback((message: PetBubbleMessage | null): void => {
    currentRef.current = message
    setCurrentState(message)
  }, [])

  const advance = useCallback((): void => {
    if (speechHeldRef.current || currentRef.current !== null) return
    const selection = selectNextPetBubble(pendingRef.current, Date.now())
    pendingRef.current = selection.remaining
    setCurrent(selection.next)
  }, [setCurrent])

  const enqueue = useCallback((incoming: PetBubbleMessage): void => {
    pendingRef.current = [
      ...pendingRef.current.filter((item) => item.kind !== incoming.kind),
      incoming
    ]
  }, [])

  const present = useCallback((incoming: PetBubbleMessage): void => {
    if (incoming.text.trim() === '') return
    const active = currentRef.current
    if (active === null || canInterruptPetBubble(active, incoming, speechHeldRef.current)) {
      setCurrent(incoming)
      return
    }
    enqueue(incoming)
  }, [enqueue, setCurrent])

  const show = useCallback((text: string, kind: PetBubbleKind, nonce: string = crypto.randomUUID()): void => {
    present(createPetBubbleMessage({ text, kind, nonce, createdAt: Date.now() }))
  }, [present])

  const expire = useCallback((nonce: string): void => {
    if (currentRef.current?.nonce !== nonce) return
    setCurrent(null)
    queueMicrotask(advance)
  }, [advance, setCurrent])

  const updateSpeechHold = useCallback((held: boolean): void => {
    speechHeldRef.current = held
    setSpeechHeldState(held)
    if (!held && currentRef.current === null) queueMicrotask(advance)
  }, [advance])

  useEffect(() => {
    const receivePayload = (value: unknown): void => {
      if (!isRecord(value) || typeof value.text !== 'string' || !isPetBubbleKind(value.kind)) return
      const payload: PetBubblePayload = {
        text: value.text,
        kind: value.kind,
        nonce: typeof value.nonce === 'string' && value.nonce !== '' ? value.nonce : crypto.randomUUID(),
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
        ...(typeof value.actionTag === 'string' ? { actionTag: value.actionTag } : {})
      }
      present(createPetBubbleMessage(payload))
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === PET_BUBBLE_STORAGE_KEY && event.newValue !== null) {
        try { receivePayload(JSON.parse(event.newValue)) } catch { /* ignore malformed cross-window payloads */ }
        return
      }
      if (event.key === PET_BUBBLE_HOLD_STORAGE_KEY && event.newValue !== null) {
        try {
          const value = JSON.parse(event.newValue) as { held?: unknown }
          if (typeof value.held === 'boolean') updateSpeechHold(value.held)
        } catch { /* ignore malformed cross-window state */ }
      }
    }
    const onLocalBubble = (event: Event): void => receivePayload((event as CustomEvent<unknown>).detail)
    const onLocalHold = (event: Event): void => {
      const detail = (event as CustomEvent<{ held?: unknown }>).detail
      if (typeof detail?.held === 'boolean') updateSpeechHold(detail.held)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('aimaid:pet-bubble', onLocalBubble)
    window.addEventListener('aimaid:bubble-hold', onLocalHold)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('aimaid:pet-bubble', onLocalBubble)
      window.removeEventListener('aimaid:bubble-hold', onLocalHold)
    }
  }, [present, updateSpeechHold])

  return { current, speechHeld, show, expire }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
