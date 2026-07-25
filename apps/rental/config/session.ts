import app from '@adonisjs/core/services/app'
import { defineConfig, stores } from '@adonisjs/session'

/**
 * Session config for the Inertia browser consoles.
 *
 * The store is the encrypted **cookie** store: the whole session payload rides
 * in a signed cookie, so there is no server-side session table to migrate and no
 * shared store for two companies to contend over. That choice also tightens
 * isolation — the cookie is host-only, so a session minted on `acme.localhost`
 * is never even transmitted to `sahara.localhost`, on top of the membership gate
 * that already refuses a foreign session server-side.
 *
 * Both realms (operator + tenant staff) hang their `web-*` session guards off
 * this one store; each guard namespaces its user id under its own key, so a
 * browser can hold an operator session on the apex and a staff session on a
 * company host without collision.
 */
const sessionConfig = defineConfig({
  enabled: true,
  cookieName: 'karimoto-session',

  // Keep the session alive across browser restarts; expire after inactivity.
  clearWithBrowser: false,
  age: '8h',

  cookie: {
    path: '/',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },

  store: 'cookie',
  stores: {
    cookie: stores.cookie(),
  },
})

export default sessionConfig
