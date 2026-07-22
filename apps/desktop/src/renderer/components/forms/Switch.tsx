import { useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string
}

export function Switch({ label, id, ...props }: SwitchProps): React.JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <label className="ui-switch" htmlFor={inputId}>
      <input id={inputId} type="checkbox" role="switch" {...props} />
      <span className="ui-switch__track" aria-hidden="true"><span /></span>
      <span>{label}</span>
    </label>
  )
}
