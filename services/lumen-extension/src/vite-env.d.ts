/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_BUS_SECRET: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
