import type { CSSProperties } from 'react'

export function ColorPalette({ colors }: { colors: readonly string[] }): React.JSX.Element {
  return (
    <span className="ui-color-palette" aria-label="主题色预览">
      {colors.map((color, index) => (
        <i
          key={`${color}-${index}`}
          className="ui-color-palette__swatch"
          style={{ '--ui-swatch-color': color } as CSSProperties}
          aria-hidden="true"
        />
      ))}
    </span>
  )
}
