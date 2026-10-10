/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Undefined until .env.local exists.
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
