import { defineConfig } from 'vite'
import adonisjs from '@adonisjs/vite/client'
import inertia from '@adonisjs/inertia/vite'
import react from '@vitejs/plugin-react'

/**
 * Frontend build for the two Inertia + React consoles. One entrypoint
 * (inertia/app/app.tsx) boots the SPA; the AdonisJS plugin wires the dev server,
 * the manifest and the `@vite`/`@viteReactRefresh` Edge tags into the backend.
 */
export default defineConfig({
  plugins: [
    inertia({ ssr: { enabled: false } }),
    react(),
    adonisjs({
      entrypoints: ['inertia/app/app.tsx'],
      reload: ['resources/views/**/*.edge'],
    }),
  ],
})
