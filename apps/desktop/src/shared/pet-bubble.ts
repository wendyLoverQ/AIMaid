export const PET_BUBBLE_STORAGE_KEY = 'aimaid.pet-bubble'
export const PET_BUBBLE_HOLD_STORAGE_KEY = 'aimaid.bubble-hold'

export type PetBubbleKind =
  | 'error'
  | 'reminder'
  | 'speech'
  | 'conversation'
  | 'feedback'
  | 'processing'
  | 'status'

export interface PetBubblePayload {
  text: string
  kind: PetBubbleKind
  nonce: string
  createdAt: number
  actionTag?: string
}
export interface PetBubbleMessage extends PetBubblePayload {
  expiresAt: number
}

const PRIORITIES: Readonly<Record<PetBubbleKind, number>> = {
  error: 100,
  reminder: 90,
  speech: 80,
  conversation: 75,
  feedback: 60,
  processing: 40,
  status: 20
}

const PENDING_LIFETIMES_MS: Readonly<Record<PetBubbleKind, number>> = {
  error: 30_000,
  reminder: 120_000,
  speech: 60_000,
  conversation: 60_000,
  feedback: 15_000,
  processing: 10_000,
  status: 8_000
}

export function petBubblePriority(kind: PetBubbleKind): number {
  return PRIORITIES[kind]
}

export function createPetBubbleMessage(payload: PetBubblePayload): PetBubbleMessage {
  return { ...payload, expiresAt: payload.createdAt + PENDING_LIFETIMES_MS[payload.kind] }
}

export function canInterruptPetBubble(
  current: PetBubbleMessage,
  incoming: PetBubbleMessage,
  speechHeld: boolean
): boolean {
  if (incoming.kind === 'error') return true
  if (speechHeld) return incoming.kind === 'speech'
  return petBubblePriority(incoming.kind) >= petBubblePriority(current.kind)
}

export function selectNextPetBubble(
  pending: readonly PetBubbleMessage[],
  now: number
): { next: PetBubbleMessage | null; remaining: PetBubbleMessage[] } {
  const active = pending.filter((item) => item.expiresAt > now)
  if (active.length === 0) return { next: null, remaining: [] }
  const ordered = [...active].sort((left, right) =>
    petBubblePriority(right.kind) - petBubblePriority(left.kind) || left.createdAt - right.createdAt)
  const [next, ...remaining] = ordered
  return { next: next ?? null, remaining }
}

export function isPetBubbleKind(value: unknown): value is PetBubbleKind {
  return typeof value === 'string' && value in PRIORITIES
}
