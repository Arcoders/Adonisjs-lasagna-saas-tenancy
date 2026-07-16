import env from '../start/env.js'
import { Secret } from '@adonisjs/core/helpers'
import { defineConfig } from '@adonisjs/core/http'

export const appKey = new Secret(env.get('APP_KEY'))

export const http = defineConfig({
  generateRequestId: true,
  allowMethodSpoofing: false,
  useAsyncLocalStorage: true,
  cookie: {
    domain: '',
    path: '/',
    maxAge: '2h',
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
  },
})
