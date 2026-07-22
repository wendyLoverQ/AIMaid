import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type PressableProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> & {
  appearance?: 'plain' | 'card' | 'navigation' | 'segmented'
  selected?: boolean
}

export function Pressable({ children, appearance = 'plain', selected, type = 'button', ...props }: PropsWithChildren<PressableProps>): React.JSX.Element {
  const selectionState = selected === undefined
    ? {}
    : props.role === 'tab'
      ? { 'aria-selected': selected }
      : { 'aria-pressed': selected }
  return <button type={type} className={`ui-pressable ui-pressable--${appearance}`} data-selected={selected || undefined} {...selectionState} {...props}>{children}</button>
}
