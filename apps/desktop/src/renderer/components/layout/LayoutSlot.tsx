import type { HTMLAttributes, PropsWithChildren } from 'react'

export type LayoutSlotVariant =
  | 'workbench-grid' | 'workbench-card__icon' | 'workbench-card__copy' | 'vault-field-control'
  | 'character-page-layout' | 'character-workspace' | 'character-summary' | 'character-status-grid' | 'character-section-header' | 'character-binding-list' | 'character-binding-item' | 'character-binding-actions' | 'character-danger'
  | 'template-card-layout' | 'template-card-summary'
  | 'character-editor-layout' | 'character-editor-placeholder'
  | 'reminder-list' | 'reminder-row__time' | 'dialog-form-section'
  | 'notebook-workspace' | 'notebook-list' | 'notebook-editor__header' | 'notebook-toolbar' | 'notebook-editor__body' | 'notebook-attachments' | 'notebook-attachment'
  | 'conversation-workspace' | 'conversation-list' | 'conversation-header' | 'conversation-messages' | 'conversation-message conversation-message--user' | 'conversation-message conversation-message--assistant' | 'conversation-composer'
  | 'appearance-content' | 'appearance-workspace' | 'appearance-themes' | 'appearance-controls' | 'appearance-controls__section' | 'theme-card-grid' | 'theme-card__preview' | 'theme-card__meta'
  | 'settings-workspace' | 'settings-navigation' | 'settings-category-list' | 'settings-content' | 'settings-content__header' | 'settings-category-header' | 'settings-display-groups' | 'settings-display-group' | 'settings-display-group__heading' | 'settings-search-results'
  | 'video-library-grid' | 'video-library-card__cover' | 'video-library-card__copy'
  | 'remote-video-hero' | 'remote-video-hero__composer'
  | 'remote-video-result-feature' | 'remote-video-result-feature__media' | 'remote-video-result-feature__copy' | 'remote-video-result-feature__actions'
  | 'remote-video-result-toolbar' | 'remote-video-result-grid' | 'remote-video-result-card' | 'remote-video-result-card__media' | 'remote-video-result-card__copy' | 'remote-video-result-card__actions'
  | 'remote-video-record-list' | 'remote-video-record-card' | 'remote-video-record-card__main' | 'remote-video-record-card__meta' | 'remote-video-record-card__actions'

export function LayoutSlot({ as = 'div', variant, children, ...props }: PropsWithChildren<Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'> & { as?: 'div' | 'section' | 'header' | 'footer' | 'aside' | 'main' | 'nav' | 'article' | 'span'; variant: LayoutSlotVariant }>): React.JSX.Element {
  const Component = as
  return <Component className={variant} {...props}>{children}</Component>
}
