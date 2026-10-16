/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  // Undefined until .env.local exists.
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
