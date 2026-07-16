import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { SSO_CONTRACT_VERSION } from './constants.js'
import type TenantSsoConfig from './tenant_sso_config.js'
import type { IdTokenClaims } from './sso_service.js'

/**
 * A pluggable identity provider. The built-in `oidc` implementation is
 * `SsoService` itself; register alternates (SAML, a bespoke OAuth flavour) on
 * {@link identityProviderRegistry} and select them per-tenant via
 * `TenantSsoConfig.provider`.
 *
 * A driver owns its own state/nonce handling end to end: `buildAuthUrl`
 * initiates the flow (persisting whatever it needs), and the host routes that
 * provider's callback to the same driver's `handleCallback`. The package never
 * shares the OIDC state store with a custom driver.
 */
export interface IdentityProviderContract {
  /** Matches `TenantSsoConfig.provider`. The built-in OIDC driver is `'oidc'`. */
  readonly name: string
  /** Contract version this driver was built against (see {@link SSO_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  buildAuthUrl(config: TenantSsoConfig): Promise<string>
  handleCallback(state: string, code: string): Promise<{ tenantId: string; claims: IdTokenClaims }>
}

/**
 * Registry of host identity providers (everything except the built-in `oidc`,
 * which `SsoService` handles directly). Validated at registration: `oidc` is
 * reserved, names are unique, and `contractVersion` is checked via
 * `assertContractCompat`.
 *
 * SSO ships no provider, so this is a MODULE-LEVEL singleton
 * ({@link identityProviderRegistry}); the host registers on the same instance
 * `SsoService` consults.
 */
export class IdentityProviderRegistry {
  readonly #providers = new Map<string, IdentityProviderContract>()

  /** The identity-provider contract version this surface implements. */
  get contractVersion(): number {
    return SSO_CONTRACT_VERSION
  }

  register(provider: IdentityProviderContract): this {
    if (!provider.name || typeof provider.name !== 'string') {
      throw new Error('IdentityProviderRegistry: a provider must have a non-empty name.')
    }
    if (provider.name === 'oidc') {
      throw new Error(
        'IdentityProviderRegistry: "oidc" is reserved for the built-in SsoService provider.'
      )
    }
    if (this.#providers.has(provider.name)) {
      throw new Error(
        `IdentityProviderRegistry: a provider named "${provider.name}" is already registered.`
      )
    }
    assertContractCompat(
      provider.contractVersion,
      SSO_CONTRACT_VERSION,
      `identity provider "${provider.name}"`
    )
    this.#providers.set(provider.name, provider)
    return this
  }

  get(name: string): IdentityProviderContract | undefined {
    return this.#providers.get(name)
  }

  has(name: string): boolean {
    return this.#providers.has(name)
  }

  list(): readonly string[] {
    return [...this.#providers.keys()]
  }

  clear(): this {
    this.#providers.clear()
    return this
  }
}

/**
 * The process-wide identity-provider registry. Register a custom provider in
 * your app's `boot()`:
 *
 * @example
 *   import { identityProviderRegistry, SSO_CONTRACT_VERSION } from '@adonisjs-lasagna/sso'
 *   identityProviderRegistry.register(new SamlProvider({ contractVersion: SSO_CONTRACT_VERSION }))
 */
export const identityProviderRegistry = new IdentityProviderRegistry()
