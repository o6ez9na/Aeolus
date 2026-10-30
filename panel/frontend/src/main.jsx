import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@xyflow/react/dist/style.css'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Installable on a phone. Only in a real build: in dev the worker would sit
// between Vite and the browser and serve yesterday's modules.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
