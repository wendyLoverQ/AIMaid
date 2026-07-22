import { useId } from 'react'

export interface RadioOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export function RadioGroup({ label, value, options, disabled = false, onChange }: {
  label: string
  value: string
  options: readonly RadioOption[]
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const name = useId()
  return <fieldset className="ui-radio-group" disabled={disabled}><legend>{label}</legend>{options.map((option) => <label className="ui-radio" key={option.value}>
    <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} />
    <span className="ui-radio__mark" />
    <span><strong>{option.label}</strong>{option.description !== undefined ? <small>{option.description}</small> : null}</span>
  </label>)}</fieldset>
}
