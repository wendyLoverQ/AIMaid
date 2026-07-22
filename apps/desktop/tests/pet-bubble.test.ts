import { describe, expect, it } from 'vitest'
import {
  canInterruptPetBubble,
  createPetBubbleMessage,
  selectNextPetBubble,
  type PetBubbleKind,
  type PetBubbleMessage
} from '../src/shared/pet-bubble'

function message(kind: PetBubbleKind, createdAt = 1_000): PetBubbleMessage {
  return createPetBubbleMessage({ text: kind, kind, nonce: `${kind}-${createdAt}`, createdAt })
}

describe('pet bubble presentation rules', () => {
  it('protects spoken content from ordinary prompts while playback is active', () => {
    const speech = message('speech')
    expect(canInterruptPetBubble(speech, message('feedback'), true)).toBe(false)
    expect(canInterruptPetBubble(speech, message('reminder'), true)).toBe(false)
    expect(canInterruptPetBubble(speech, message('speech', 2_000), true)).toBe(true)
    expect(canInterruptPetBubble(speech, message('error'), true)).toBe(true)
  })

  it('uses explicit priority when speech is not active', () => {
    expect(canInterruptPetBubble(message('speech'), message('status'), false)).toBe(false)
    expect(canInterruptPetBubble(message('processing'), message('speech'), false)).toBe(true)
    expect(canInterruptPetBubble(message('feedback'), message('reminder'), false)).toBe(true)
  })

  it('drops stale deferred prompts and resumes the highest priority live item', () => {
    const stale = message('status', 0)
    const feedback = message('feedback', 10_000)
    const reminder = message('reminder', 11_000)
    const selection = selectNextPetBubble([stale, feedback, reminder], 12_000)
    expect(selection.next?.kind).toBe('reminder')
    expect(selection.remaining.map((item) => item.kind)).toEqual(['feedback'])
  })
})
