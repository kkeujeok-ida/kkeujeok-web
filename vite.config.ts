import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Shown in the sync log export header.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __BUILD_ID__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev'),
  },
  plugins: [react()],
  // The OAuth authorized origin includes the port, so never fall back to another one.
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
})
