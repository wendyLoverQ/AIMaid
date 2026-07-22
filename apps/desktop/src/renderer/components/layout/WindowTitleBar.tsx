import type { ReactNode } from 'react'
import { bridge } from '../../shared/bridge'
import { IconButton } from '../base/IconButton'

export interface WindowTitleBarProps {
  title: string
  subtitle?: string
  onBack?: () => void
  onClose?: () => void | Promise<void>
  tools?: ReactNode
}

export function WindowTitleBar({ title, subtitle, onBack, onClose, tools }: WindowTitleBarProps): React.JSX.Element {
  return (
    <header className="ui-titlebar">
      <div className="ui-titlebar__identity">
        {onBack !== undefined ? <IconButton label="返回" size="sm" onClick={onBack}>←</IconButton> : null}
        <span className="ui-titlebar__mark" aria-hidden="true">A</span>
        <span className="ui-titlebar__text"><strong>{title}</strong>{subtitle !== undefined ? <small>{subtitle}</small> : null}</span>
      </div>
      <div className="ui-titlebar__spacer" />
      {tools !== undefined ? <div className="ui-titlebar__tools">{tools}</div> : null}
      <div className="ui-titlebar__controls">
        <IconButton label="最小化" size="sm" onClick={() => void bridge.window.minimize()}>—</IconButton>
        <IconButton label="最大化或恢复" size="sm" onClick={() => void bridge.window.toggleMaximize()}>□</IconButton>
        <IconButton label="关闭" size="sm" className="ui-titlebar__close" onClick={() => void (onClose?.() ?? bridge.window.close())}>×</IconButton>
      </div>
    </header>
  )
}
