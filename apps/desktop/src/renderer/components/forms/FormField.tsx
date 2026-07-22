import { useId } from 'react'
import type { ReactNode } from 'react'

export interface FormFieldProps {
  label: string
  children: ReactNode
  required?: boolean
  description?: string
  error?: string
  htmlFor?: string
  orientation?: 'vertical' | 'horizontal'
}

export function FormField({ label, children, required = false, description, error, htmlFor, orientation = 'vertical' }: FormFieldProps): React.JSX.Element {
  const descriptionId = useId()
  return <div className={`ui-form-field ui-form-field--${orientation}`} aria-describedby={description !== undefined || error !== undefined ? descriptionId : undefined}>
    <label className="ui-form-field__label" htmlFor={htmlFor}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
    <div className="ui-form-field__control">{children}</div>
    {description !== undefined || error !== undefined ? <p id={descriptionId} className={error !== undefined ? 'ui-form-field__error' : 'ui-form-field__description'}>{error ?? description}</p> : null}
  </div>
}
