import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { neon } from './neon'
import { clearAuthCallback, completeAuthCallback } from './auth-bootstrap'
import './styles.css'

const root = createRoot(document.getElementById('root')!)

async function start() {
  root.render(<main className="auth-page"><section role="status" className="auth-card status-card">Completing your secure sign-in…</section></main>)
  try {
    await completeAuthCallback(neon.auth, window)
    root.render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>,
    )
  } catch {
    root.render(
      <main className="auth-page"><section className="auth-card status-card" role="alert">
        <p>Sign-in could not be completed. Please sign in again.</p>
        <button className="primary-button" onClick={() => {
          clearAuthCallback(window)
          window.location.reload()
        }}>Return to sign-in</button>
      </section></main>,
    )
  }
}

void start()
