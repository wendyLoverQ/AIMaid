import type { ReactNode } from 'react'
import { IconButton } from '../base/IconButton'

export interface TagProps { children: ReactNode; selected?: boolean; disabled?: boolean; onRemove?: () => void }
export function Tag({ children, selected = false, disabled = false, onRemove }: TagProps): React.JSX.Element {
  return <span className="ui-tag" aria-disabled={disabled} data-selected={selected || undefined}>{children}{onRemove !== undefined ? <IconButton label="移除" size="sm" disabled={disabled} onClick={onRemove}>×</IconButton> : null}</span>
}
