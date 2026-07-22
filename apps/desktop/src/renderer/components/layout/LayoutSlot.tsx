import type { HTMLAttributes, PropsWithChildren } from 'react'

export type LayoutSlotVariant =
  | 'workbench-sections' | 'workbench-group' | 'workbench-group__header' | 'workbench-grid' | 'workbench-card__icon' | 'workbench-card__copy' | 'vault-field-control'
  | 'character-page-layout' | 'character-workspace' | 'character-summary' | 'character-detail-sections' | 'character-danger'
  | 'template-card-layout' | 'template-card-summary'
  | 'character-editor-layout' | 'character-editor-placeholder'
  | 'reminder-list' | 'reminder-row__time' | 'dialog-form-section'
  | 'notebook-workspace' | 'notebook-list' | 'notebook-editor__header' | 'notebook-toolbar' | 'notebook-editor__body' | 'notebook-attachments' | 'notebook-attachment'
  | 'conversation-workspace' | 'conversation-list' | 'conversation-header' | 'conversation-messages' | 'conversation-message conversation-message--user' | 'conversation-message conversation-message--assistant' | 'conversation-composer'
  | 'appearance-content' | 'theme-card-grid' | 'theme-card__preview' | 'theme-card__block'
  | 'status-overview' | 'status-tier status-tier--primary' | 'status-tier status-tier--secondary' | 'status-tier status-tier--detail'
  | 'settings-workspace' | 'settings-navigation' | 'settings-category-list' | 'settings-content' | 'settings-content__header' | 'settings-search-results'
  | 'video-library-grid' | 'video-library-card__cover' | 'video-library-card__copy'

export function LayoutSlot({ as = 'div', variant, children, ...props }: PropsWithChildren<Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'> & { as?: 'div' | 'section' | 'header' | 'footer' | 'aside' | 'main' | 'nav' | 'article' | 'span'; variant: LayoutSlotVariant }>): React.JSX.Element {
  const Component = as
  return <Component className={variant} {...props}>{children}</Component>
}
