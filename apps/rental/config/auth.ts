import { defineConfig } from '@adonisjs/auth'
import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'
import { sessionGuard, sessionUserProvider } from '@adonisjs/auth/session'
import type { InferAuthenticators, InferAuthEvents, Authenticators } from '@adonisjs/auth/types'

/**
 * Two fully separate auth realms, one token guard each. They share nothing: the
 * `backoffice` guard reads operators from `backoffice.backoffice_users` and
 * stores tokens in `backoffice.auth_access_tokens`; the `tenant` guard reads
 * staff from the resolved tenant's own schema, so its tokens live in
 * `tenant_<uuid>.auth_access_tokens`. The schema routing is not configured
 * here — it falls out of the model each provider points at (token storage
 * resolves through `model.$adapter`, and the package installs the right adapter
 * on each base model at boot).
 *
 * The browser consoles (Inertia) authenticate with the `web-*` session guards;
 * the token guards stay for the programmatic API and the e2e suite. Each session
 * guard points at the SAME model as its token twin, so schema routing is
 * identical — a `web-tenant` session still loads staff from the resolved
 * company's own schema. Remember-me tokens are off, so no extra table is needed:
 * the encrypted cookie store holds the whole session.
 */
const authConfig = defineConfig({
  default: 'tenant',
  guards: {
    'backoffice': tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
        model: () => import('#app/models/backoffice/backoffice_user'),
      }),
    }),
    'tenant': tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
        model: () => import('#app/models/tenant_scoped/tenant_user'),
      }),
    }),
    'web-backoffice': sessionGuard({
      useRememberMeTokens: false,
      provider: sessionUserProvider({
        model: () => import('#app/models/backoffice/backoffice_user'),
      }),
    }),
    'web-tenant': sessionGuard({
      useRememberMeTokens: false,
      provider: sessionUserProvider({
        model: () => import('#app/models/tenant_scoped/tenant_user'),
      }),
    }),
  },
})

export default authConfig

declare module '@adonisjs/auth/types' {
  export interface Authenticators extends InferAuthenticators<typeof authConfig> {}
}

declare module '@adonisjs/core/types' {
  interface EventsList extends InferAuthEvents<Authenticators> {}
}
