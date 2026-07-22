import type { ButtonHTMLAttributes } from 'react'
import { Loading } from '../feedback/Loading'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  tooltip?: string
  variant?: 'default' | 'promptVoice'
}

export function IconButton({ label, tooltip, size = 'md', loading = false, disabled, variant = 'default', className = '', children, ...props }: IconButtonProps): React.JSX.Element {
  const variantClass = variant === 'promptVoice' ? 'prompt-voice-button' : ''
  return (
    <button
      className={`ui-icon-button ui-control--${size} ${variantClass} ${className}`.trim()}
      type="button"
      aria-label={label}
      title={tooltip ?? label}
      disabled={disabled === true || loading}
      aria-busy={loading}
      {...props}
    >
      {loading ? <Loading size="sm" label="" /> : children}
    </button>
  )
}
