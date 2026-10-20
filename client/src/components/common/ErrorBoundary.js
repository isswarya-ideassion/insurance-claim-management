import { Component } from 'react'
import { ErrorState } from '@/components/common/States.js'

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

/**
 * Catches render errors (including failed lazy page loads) so one broken page
 * shows an error panel instead of unmounting the whole app. Pass `resetKey`
 * (e.g. the pathname) to clear the error when the user navigates elsewhere.
 */
export class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Page render failed', error, info?.componentStack)
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    // A lazy page chunk that failed to load stays failed in React.lazy's cache; only a reload retries it.
    const chunkFailed = CHUNK_ERROR.test(error.message || '')
    return (
      <ErrorState
        className={this.props.className}
        title={chunkFailed ? 'This page could not be loaded' : 'This page ran into a problem'}
        error={{ message: chunkFailed ? 'The page code could not be downloaded. Check your connection or that the app server is running, then try again.' : 'An unexpected error occurred while displaying this page. Try again, or go back to the previous page.' }}
        onRetry={() => (chunkFailed ? window.location.reload() : this.setState({ error: null }))}
      />
    )
  }
}
