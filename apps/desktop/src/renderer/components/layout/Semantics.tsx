import { forwardRef } from 'react'
import type {
  HTMLAttributes, LabelHTMLAttributes, ProgressHTMLAttributes, PropsWithChildren,
  TimeHTMLAttributes
} from 'react'

type Clean<T> = Omit<T, 'className' | 'style' | 'dangerouslySetInnerHTML'>

export const Container = forwardRef<HTMLDivElement, Clean<HTMLAttributes<HTMLDivElement>>>(function Container(props, ref) {
  return <div ref={ref} className="ui-container" {...props} />
})
export const MainRegion = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function MainRegion(props, ref) {
  return <main ref={ref} className="ui-main-region" {...props} />
})
export const Section = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Section(props, ref) {
  return <section ref={ref} className="ui-section" {...props} />
})
export const Article = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Article(props, ref) {
  return <article ref={ref} className="ui-article" {...props} />
})
export const Aside = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Aside(props, ref) {
  return <aside ref={ref} className="ui-aside" {...props} />
})
export const Header = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Header(props, ref) {
  return <header ref={ref} className="ui-header" {...props} />
})
export const Footer = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Footer(props, ref) {
  return <footer ref={ref} className="ui-footer" {...props} />
})
export const Navigation = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Navigation(props, ref) {
  return <nav ref={ref} className="ui-navigation" {...props} />
})
export const InlineText = forwardRef<HTMLSpanElement, Clean<HTMLAttributes<HTMLSpanElement>>>(function InlineText(props, ref) {
  return <span ref={ref} className="ui-inline-text" {...props} />
})
export const SmallText = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function SmallText(props, ref) {
  return <small ref={ref} className="ui-small-text" {...props} />
})
export const Paragraph = forwardRef<HTMLParagraphElement, Clean<HTMLAttributes<HTMLParagraphElement>>>(function Paragraph(props, ref) {
  return <p ref={ref} className="ui-paragraph" {...props} />
})
export const Title1 = forwardRef<HTMLHeadingElement, Clean<HTMLAttributes<HTMLHeadingElement>>>(function Title1(props, ref) {
  return <h1 ref={ref} className="ui-title ui-title--1" {...props} />
})
export const Title2 = forwardRef<HTMLHeadingElement, Clean<HTMLAttributes<HTMLHeadingElement>>>(function Title2(props, ref) {
  return <h2 ref={ref} className="ui-title ui-title--2" {...props} />
})
export const Title3 = forwardRef<HTMLHeadingElement, Clean<HTMLAttributes<HTMLHeadingElement>>>(function Title3(props, ref) {
  return <h3 ref={ref} className="ui-title ui-title--3" {...props} />
})
export const Title4 = forwardRef<HTMLHeadingElement, Clean<HTMLAttributes<HTMLHeadingElement>>>(function Title4(props, ref) {
  return <h4 ref={ref} className="ui-title ui-title--4" {...props} />
})
export const Emphasis = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function Emphasis(props, ref) {
  return <i ref={ref} className="ui-emphasis" {...props} />
})
export const DescriptionList = forwardRef<HTMLDListElement, Clean<HTMLAttributes<HTMLDListElement>>>(function DescriptionList(props, ref) {
  return <dl ref={ref} className="ui-description-list" {...props} />
})
export const DescriptionTerm = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function DescriptionTerm(props, ref) {
  return <dt ref={ref} className="ui-description-term" {...props} />
})
export const DescriptionValue = forwardRef<HTMLElement, Clean<HTMLAttributes<HTMLElement>>>(function DescriptionValue(props, ref) {
  return <dd ref={ref} className="ui-description-value" {...props} />
})
export const TimeValue = forwardRef<HTMLTimeElement, Clean<TimeHTMLAttributes<HTMLTimeElement>>>(function TimeValue(props, ref) {
  return <time ref={ref} className="ui-time" {...props} />
})
export const CodeBlock = forwardRef<HTMLPreElement, Clean<HTMLAttributes<HTMLPreElement>>>(function CodeBlock(props, ref) {
  return <pre ref={ref} className="ui-code ui-code--block" {...props} />
})
export const FormLabel = forwardRef<HTMLLabelElement, Clean<LabelHTMLAttributes<HTMLLabelElement>>>(function FormLabel(props, ref) {
  return <label ref={ref} className="ui-form-label" {...props} />
})
export const Meter = forwardRef<HTMLProgressElement, Clean<ProgressHTMLAttributes<HTMLProgressElement>>>(function Meter(props, ref) {
  return <progress ref={ref} className="ui-meter" {...props} />
})
export function LineBreak(): React.JSX.Element { return <br /> }

export function ContentGroup({ children }: PropsWithChildren): React.JSX.Element {
  return <div className="ui-content-group">{children}</div>
}
