import '../css/app.css'
import { createInertiaApp } from '@inertiajs/react'
import { createRoot } from 'react-dom/client'
import { resolvePageComponent } from '@adonisjs/inertia/helpers'

const appName = 'Karimoto'

createInertiaApp({
  progress: { color: '#e2603b' },
  title: (title) => (title ? `${title} · ${appName}` : appName),

  resolve: (name) => {
    return resolvePageComponent(
      `../pages/${name}.tsx`,
      import.meta.glob('../pages/**/*.tsx')
    )
  },

  setup({ el, App, props }) {
    createRoot(el).render(<App {...props} />)
  },
})
