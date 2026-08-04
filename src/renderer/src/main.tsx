import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { ErrorBoundary } from '@renderer/lib/ErrorBoundary'
import { initRendererLogging } from './logging/init'
import { initRendererSentry } from './logging/sentry'
import { installRendererErrorHandlers } from './logging/handlers'
import './styles.css'

async function boot(): Promise<void> {
  await initRendererLogging()
  installRendererErrorHandlers()

  let telemetryEnabled = false
  try {
    const res = await window.vyotiq?.getSettings?.()
    if (res?.ok) telemetryEnabled = res.data.telemetryEnabled === true
  } catch {
    // ignore — logger still works locally
  }
  initRendererSentry(telemetryEnabled)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}

void boot()
