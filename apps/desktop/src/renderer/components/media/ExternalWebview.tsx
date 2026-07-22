import { createElement, forwardRef } from 'react'
export interface ExternalWebviewProps { source: string; partition: string; label: string }
export const ExternalWebview = forwardRef<HTMLElement, ExternalWebviewProps>(function ExternalWebview({ source, partition, label }, ref) {
  return createElement('webview', { ref, src: source, partition, className: 'ui-external-webview', 'aria-label': label })
})
