import { defineConfig } from '@adonisjs/auth'
import { tokensGuard, tokensUserProvider } from '@adonisjs/auth/access_tokens'
import type { InferAuthenticators, InferAuthEvents, Authenticators } from '@adonisjs/auth/types'

/**
 * Two fully separate auth realms, one guard each. They share nothing: the
 * `backoffice` guard reads operators from `backoffice.backoffice_users` and
 * stores its tokens in `backoffice.auth_access_tokens`; the `tenant` guard
 * reads users from the resolved tenant's own schema, so its tokens live in
 * `tenant_<uuid>.auth_access_tokens` too. The schema routing is not configured
 * here. It falls out of the model each provider points at: token storage
 * resolves through `model.$adapter`, and the package installs the right
 * adapter on each base model at boot.
 */
const authConfig = defineConfig({
  default: 'tenant',
  guards: {
    backoffice: tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
        model: () => import('#app/models/backoffice/backoffice_user'),
      }),
    }),
    tenant: tokensGuard({
      provider: tokensUserProvider({
        tokens: 'accessTokens',
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
