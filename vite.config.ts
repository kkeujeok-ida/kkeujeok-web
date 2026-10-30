import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The short commit hash of the build, `unknown` when git is not there.
function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  // Shown in the sync log export header.
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __BUILD_ID__: JSON.stringify(commitHash()),
    // The web has no build number apart from the commit.
    __BUILD_NUMBER__: JSON.stringify('unknown'),
  },
  plugins: [react()],
  // The OAuth authorized origin includes the port, so never fall back to another one.
  server: { port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
})
