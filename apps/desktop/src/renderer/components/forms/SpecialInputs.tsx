import type { ChangeEventHandler } from 'react'
import { Input } from './Input'

interface ValueInputProps {
  label?: string
  value: string
  disabled?: boolean
  error?: string
  hint?: string
  onChange: ChangeEventHandler<HTMLInputElement>
}

export function SearchInput(props: ValueInputProps & { placeholder?: string }): React.JSX.Element {
  return <Input type="search" {...props} />
}

export function NumberInput(props: Omit<ValueInputProps, 'value'> & { value: number | ''; min?: number; max?: number; step?: number }): React.JSX.Element {
  return <Input type="number" {...props} />
}

export function DateInput(props: ValueInputProps & { min?: string; max?: string }): React.JSX.Element {
  return <Input type="date" {...props} />
}

export function DateTimeInput(props: ValueInputProps & { min?: string; max?: string }): React.JSX.Element {
  return <Input type="datetime-local" {...props} />
}

export function FileInput({ label, accept, multiple = false, disabled = false, onChange, hint }: {
  label: string
  accept?: string
  multiple?: boolean
  disabled?: boolean
  hint?: string
  onChange: ChangeEventHandler<HTMLInputElement>
}): React.JSX.Element {
  return <Input label={label} type="file" {...(accept === undefined ? {} : { accept })} multiple={multiple} disabled={disabled} onChange={onChange} {...(hint === undefined ? {} : { hint })} />
}
