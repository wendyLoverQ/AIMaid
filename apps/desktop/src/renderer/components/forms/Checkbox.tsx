import { useId } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
  description?: string
}

export function Checkbox({ label, description, id, ...props }: CheckboxProps): React.JSX.Element {
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <label className="ui-check" htmlFor={inputId}>
      <input id={inputId} type="checkbox" {...props} />
      <span className="ui-check__mark" aria-hidden="true">✓</span>
      {label !== undefined ? <span>
        <strong>{label}</strong>
        {description !== undefined ? <small>{description}</small> : null}
      </span> : null}
    </label>
  )
}
