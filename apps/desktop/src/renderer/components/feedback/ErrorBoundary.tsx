import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ErrorState } from './ErrorState'

interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { error: Error | null }

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error boundary', { name: error.name, message: error.message, componentStack: info.componentStack })
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main className="page-shell page-shell--compact">
          <ErrorState
            title="页面无法继续显示"
            message={this.state.error.message}
            onRetry={() => this.setState({ error: null })}
          />
        </main>
      )
    }
    return this.props.children
  }
}
