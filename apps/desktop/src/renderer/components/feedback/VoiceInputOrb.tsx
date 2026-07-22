export type VoiceInputOrbState = 'starting' | 'recording' | 'transcribing' | 'error'

export function VoiceInputOrb({ state, message, onActivate }: {
  state: VoiceInputOrbState
  message: string
  onActivate: () => void
}): React.JSX.Element {
  const actionable = state === 'recording' || state === 'error'
  return (
    <button
      className={`ui-voice-input-orb ui-voice-input-orb--${state}`}
      type="button"
      aria-label={message}
      aria-live="polite"
      aria-busy={state === 'starting' || state === 'transcribing'}
      disabled={!actionable}
      onClick={onActivate}
    >
      <span className="ui-voice-input-orb__pulse" aria-hidden="true" />
      <span className="ui-voice-input-orb__icon" aria-hidden="true">{state === 'error' ? '!' : '●'}</span>
    </button>
  )
}
