import { forwardRef } from 'react'
import type {
  CanvasHTMLAttributes,
  FormHTMLAttributes,
  HTMLAttributes,
  ImgHTMLAttributes,
  PropsWithChildren,
  ReactNode
} from 'react'

type Gap = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'

export function Page({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-page">{children}</div>
}

export function PageContent({ children, scroll = true }: PropsWithChildren<{ scroll?: boolean }>): React.JSX.Element {
  return <main className={`ui-page-content${scroll ? ' ui-page-content--scroll' : ''}`}>{children}</main>
}

export function Stack({ children, gap = 'md', align = 'stretch' }: PropsWithChildren<{ gap?: Gap; align?: 'start' | 'center' | 'end' | 'stretch' }>): React.JSX.Element {
  return <div className={`ui-stack ui-gap--${gap} ui-align--${align}`}>{children}</div>
}

export function Inline({ children, gap = 'sm', align = 'center', wrap = true, justify = 'start' }: PropsWithChildren<{
  gap?: Gap
  align?: 'start' | 'center' | 'end' | 'stretch'
  wrap?: boolean
  justify?: 'start' | 'center' | 'end' | 'between'
}>): React.JSX.Element {
  return <div className={`ui-inline ui-gap--${gap} ui-align--${align} ui-justify--${justify}${wrap ? ' ui-inline--wrap' : ''}`}>{children}</div>
}

export function Grid({ children, columns = 'auto', gap = 'md' }: PropsWithChildren<{ columns?: 'auto' | 'one' | 'two' | 'three' | 'sidebar' | 'detail'; gap?: Gap }>): React.JSX.Element {
  return <div className={`ui-grid ui-grid--${columns} ui-gap--${gap}`}>{children}</div>
}

export function Center({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-center">{children}</div>
}

export function Divider(): React.JSX.Element {
  return <hr className="ui-divider" />
}

export function Form({ children, onSubmit, ...props }: PropsWithChildren<Omit<FormHTMLAttributes<HTMLFormElement>, 'className' | 'style'>>): React.JSX.Element {
  return <form className="ui-form" onSubmit={onSubmit} {...props}>{children}</form>
}

export function Fieldset({ legend, children, disabled = false }: PropsWithChildren<{ legend: ReactNode; disabled?: boolean }>): React.JSX.Element {
  return <fieldset className="ui-fieldset" disabled={disabled}><legend>{legend}</legend>{children}</fieldset>
}

export function Heading({ level = 2, children }: PropsWithChildren<{ level?: 1 | 2 | 3 | 4 }>): React.JSX.Element {
  if (level === 1) return <h1 className="ui-heading ui-heading--1">{children}</h1>
  if (level === 3) return <h3 className="ui-heading ui-heading--3">{children}</h3>
  if (level === 4) return <h4 className="ui-heading ui-heading--4">{children}</h4>
  return <h2 className="ui-heading ui-heading--2">{children}</h2>
}

export function Text({ children, tone = 'default', size = 'md', as = 'span', wrap = false }: PropsWithChildren<{
  tone?: 'default' | 'secondary' | 'muted' | 'danger' | 'success'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  as?: 'span' | 'p'
  wrap?: boolean
}>): React.JSX.Element {
  const className = `ui-text ui-text--${tone} ui-text--${size}${wrap ? ' ui-text--wrap' : ''}`
  return as === 'p' ? <p className={className}>{children}</p> : <span className={className}>{children}</span>
}

export function Strong({ children }: PropsWithChildren): React.JSX.Element {
  return <strong className="ui-strong">{children}</strong>
}

export function Code({ children, block = false }: PropsWithChildren<{ block?: boolean }>): React.JSX.Element {
  return block ? <pre className="ui-code ui-code--block">{children}</pre> : <code className="ui-code">{children}</code>
}

export function KeyboardKey({ children }: PropsWithChildren): React.JSX.Element {
  return <kbd className="ui-keyboard-key">{children}</kbd>
}

export function TimeText({ value, children }: PropsWithChildren<{ value: string }>): React.JSX.Element {
  return <time className="ui-time" dateTime={value}>{children}</time>
}

export const MediaImage = forwardRef<HTMLImageElement, Omit<ImgHTMLAttributes<HTMLImageElement>, 'className' | 'style'>>(function MediaImage(props, ref) {
  return <img ref={ref} className="ui-media-image" {...props} />
})

export const MediaCanvas = forwardRef<HTMLCanvasElement, Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'className' | 'style'>>(function MediaCanvas(props, ref) {
  return <canvas ref={ref} className="ui-media-canvas" {...props} />
})

export const TransparentStage = forwardRef<HTMLElement, Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'>>(function TransparentStage(props, ref) {
  return <main ref={ref} className="ui-transparent-stage" {...props} />
})

export const TransparentCanvas = forwardRef<HTMLCanvasElement, Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'className' | 'style'>>(function TransparentCanvas(props, ref) {
  return <canvas ref={ref} className="ui-transparent-canvas" {...props} />
})

export const PetItemSurface = forwardRef<HTMLDivElement, Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>>(function PetItemSurface(props, ref) {
  return <div ref={ref} className="ui-pet-item" {...props} />
})

export function VisualRegion({ children, ratio = 'auto', fit = 'contain' }: PropsWithChildren<{ ratio?: 'auto' | 'square' | 'portrait' | 'video'; fit?: 'contain' | 'cover' }>): React.JSX.Element {
  return <div className={`ui-visual-region ui-visual-region--${ratio} ui-visual-region--${fit}`}>{children}</div>
}

export function VisuallyHidden({ children }: PropsWithChildren): React.JSX.Element {
  return <span className="ui-visually-hidden">{children}</span>
}

export function SemanticRegion({ children, label }: PropsWithChildren<{ label: string }>): React.JSX.Element {
  return <section className="ui-semantic-region" aria-label={label}>{children}</section>
}
