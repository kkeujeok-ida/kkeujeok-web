import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // The OAuth authorized origin includes the port, so never fall back to another one.
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
})
