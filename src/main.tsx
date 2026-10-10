import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../design_tokens/build/tokens.css'
import './ui/app.css'
import { App } from './ui/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
