export interface TabItem {
  id: string
  label: string
  disabled?: boolean
}

export interface TabsProps {
  items: TabItem[]
  value: string
  onChange: (id: string) => void
  label: string
}

export function Tabs({ items, value, onChange, label }: TabsProps): React.JSX.Element {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
        {items.map((item) => (
          <button key={item.id} type="button" role="tab" className="ui-tabs__tab" aria-selected={value === item.id}
            disabled={item.disabled} onClick={() => onChange(item.id)}>
            {item.label}
          </button>
        ))}
    </div>
  )
}
