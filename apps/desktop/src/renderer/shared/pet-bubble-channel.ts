import {
  PET_BUBBLE_STORAGE_KEY,
  type PetBubbleKind,
  type PetBubblePayload
} from '../../shared/pet-bubble'

export function publishPetBubble(text: string, kind: PetBubbleKind, actionTag?: string): void {
  const payload: PetBubblePayload = {
    text,
    kind,
    nonce: crypto.randomUUID(),
    createdAt: Date.now(),
    ...(actionTag === undefined ? {} : { actionTag })
  }
  localStorage.setItem(PET_BUBBLE_STORAGE_KEY, JSON.stringify(payload))
  window.dispatchEvent(new CustomEvent('aimaid:pet-bubble', { detail: payload }))
}
