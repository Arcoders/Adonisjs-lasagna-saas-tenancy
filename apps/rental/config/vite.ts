import { defineConfig } from '@adonisjs/vite'

/**
 * Backend half of the Vite integration: where `vite build` writes the bundle and
 * the manifest the server reads to resolve `@vite([...])` tags to hashed asset
 * URLs. The frontend half (plugins, entrypoints) lives in the root vite.config.ts.
 */
const viteBackendConfig = defineConfig({
  buildDirectory: 'public/assets',
  manifestFile: 'public/assets/.vite/manifest.json',
  assetsUrl: '/assets',
})

export default viteBackendConfig
