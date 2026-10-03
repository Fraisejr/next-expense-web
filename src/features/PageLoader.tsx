import { Component, Suspense, type ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'

class PageLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (this.state.failed) return <div className="page-content narrow-page"><section className="panel" role="alert">
      <p>Could not open this page. Check your connection and reload to try again.</p>
      <button type="button" className="secondary-button" onClick={() => window.location.reload()}>Reload app</button>
    </section></div>
    return this.props.children
  }
}

export function PageLoader({ name, children }: { name: string; children: ReactNode }) {
  return <PageLoadBoundary key={name}><Suspense fallback={<div className="page-content narrow-page"><section className="panel" role="status" aria-live="polite">
    <LoaderCircle size={18} className="spin-icon" /> Loading {name}…
  </section></div>}>{children}</Suspense></PageLoadBoundary>
}
