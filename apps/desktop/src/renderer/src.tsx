import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/feedback/ErrorBoundary'
import { GlobalUiRoot } from './theme/GlobalUiRoot'
import { bridge } from './shared/bridge'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Renderer root element is missing')

const content = (
  <GlobalUiRoot>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </GlobalUiRoot>
)

createRoot(root).render(bridge.window.kind === 'pet' || bridge.window.kind === 'voice-input' ? content : <StrictMode>{content}</StrictMode>)
