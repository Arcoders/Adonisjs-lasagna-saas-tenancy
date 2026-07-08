import type TenantSsoConfig from './tenant_sso_config.js'
import { buildAuthorizationUrl, isLoopbackIssuer } from './authorize.js'
import { identityProviderRegistry } from './identity_provider.js'
import { SSO_CONTRACT_VERSION } from './constants.js'
import { randomBytes } from 'node:crypto'

interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
}

/**
 * The OpenID Connect ID-token claims Lasagna reads after cryptographically
 * verifying a provider's token: the issuer, audience, expiry and issued-at
 * timestamps, the subject identifier, an optional nonce, and the standard profile
 * claims (email, verification flag, name) used to resolve or provision the user.
 * Any additional provider claims are preserved on the index signature.
 */
export interface IdTokenClaims {
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  sub: string
  nonce?: string
  email?: string
  email_verified?: boolean
  name?: string
  [claim: string]: unknown
}

const STATE_TTL_SECONDS = 600
const CLOCK_SKEW_SECONDS = 60
// Cap server-side calls to the IdP so a hung/slow provider can't pin a callback
// request (and its tenant connection) open indefinitely.
const IDP_FETCH_TIMEOUT_MS = 10_000

/**
 * Injectable seams for the security-critical SSO flow. Everything that reaches a
 * booted-app singleton (Redis, the core cache, the SSRF guard, the AES helpers)
 * lives here behind a default that lazily resolves the real module on first use.
 *
 * Two reasons it is shaped this way:
 *  - the module stays loadable in a bare unit runner (the core `/services` and
 *    root barrels and `@adonisjs/redis/services/main` all touch `app.booted` at
 *    import time, so they must not be top-level value imports here), and
 *  - the unit suite can pass fakes so the GETDEL / SSRF / issuer-match / nonce
 *    guards are exercised without a database or a real Redis.
 *
 * Production never passes `deps`; `container.make(SsoService)` constructs it
 * argument-free and the defaults below apply.
 */
/** The row attributes `upsertConfig` writes (post-encryption). */
export interface PersistedSsoConfigAttrs {
  provider: 'oidc'
  clientId: string
  clientSecret: string
  issuerUrl: string
  redirectUri: string
  scopes: string[]
  enabled: boolean
}

export interface SsoServiceDeps {
  redis: {
    getdel(key: string): Promise<string | null>
    setex(key: string, ttlSeconds: number, value: string): Promise<unknown>
  }
  fetch: typeof fetch
  cacheGetOrSet<T>(opts: { key: string; ttl: string; factory: () => Promise<T> }): Promise<T>
  loadEnabledConfig(tenantId: string): Promise<TenantSsoConfig | null>
  persistConfig(tenantId: string, attrs: PersistedSsoConfigAttrs): Promise<TenantSsoConfig>
  validateHostIsPublic(url: string): Promise<string | null | undefined>
  encryptSecret(value: string): string | Promise<string>
  decryptSecret(value: string): string | Promise<string>
  importJose(): Promise<typeof import('jose')>
}

function defaultDeps(): SsoServiceDeps {
  const redisLazy = async () => (await import('@adonisjs/redis/services/main')).default
  return {
    redis: {
      async getdel(key) {
        return (await redisLazy()).getdel(key)
      },
      async setex(key, ttlSeconds, value) {
        return (await redisLazy()).setex(key, ttlSeconds, value)
      },
    },
    fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // Route the server-side IdP calls (discovery, token exchange) through the
      // pinned safeFetch seam: it resolves and validates the host once and connects
      // only to that address, closing the DNS-rebinding window.
      //
      // allowLoopback is derived from the TARGET, not hardcoded true. It is enabled
      // only when the target hostname is ITSELF loopback (an in-process test IdP on
      // 127.0.0.1). A public hostname that resolves to loopback via DNS rebinding is
      // then rejected by safeFetch's own pin instead of being trusted — the previous
      // unconditional `allowLoopback: true` disabled that pin for the token POST,
      // which carries the decrypted OIDC client_secret. Production issuers are never
      // loopback (the SsoController rejects a loopback issuerUrl from admin input),
      // and discovery already range-checks token_endpoint/jwks_uri via
      // validateResolvedHostIsPublic, so this only affects the rebind edge.
      const target = String(input)
      const { safeFetch } = await import('@adonisjs-lasagna/saas-tenancy')
      return safeFetch(target, {
        method: init?.method,
        headers: (init?.headers as Record<string, string>) ?? undefined,
        body: init?.body as string | URLSearchParams | undefined,
        signal: init?.signal ?? undefined,
        allowLoopback: isLoopbackIssuer(target),
      })
    },
    async cacheGetOrSet(opts) {
      const { getCache } = await import('@adonisjs-lasagna/saas-tenancy/services')
      return getCache().namespace('sso').getOrSet(opts) as Promise<ReturnType<typeof opts.factory>>
    },
    async loadEnabledConfig(tenantId) {
      const { default: TenantSsoConfig } = await import('./tenant_sso_config.js')
      return TenantSsoConfig.query().where('tenant_id', tenantId).where('enabled', true).first()
    },
    async persistConfig(tenantId, attrs) {
      const { default: TenantSsoConfig } = await import('./tenant_sso_config.js')
      return TenantSsoConfig.updateOrCreate({ tenantId }, attrs)
    },
    async validateHostIsPublic(url) {
      const { validateResolvedHostIsPublic } = await import('@adonisjs-lasagna/saas-tenancy')
      return validateResolvedHostIsPublic(url)
    },
    async encryptSecret(value) {
      const { writeSecret } = await import('@adonisjs-lasagna/saas-tenancy')
      return writeSecret(value, 'ssoClientSecret')
    },
    async decryptSecret(value) {
      // Fail closed and domain-separated: readSecret uses decryptStrict under the
      // sso:client_secret context, so a plaintext, tampered, or wrong-context
      // value throws instead of being used as a live token-exchange credential.
      // Hosts upgrading from the lenient default-context scheme must run
      // `tenant:secrets:reencrypt` first (see the SSO guide).
      const { readSecret } = await import('@adonisjs-lasagna/saas-tenancy')
      return readSecret(value, 'ssoClientSecret')
    },
    importJose() {
      return import('jose')
    },
  }
}

/**
 * The built-in `oidc` identity provider and the per-tenant SSO service. It stores
 * and reads each tenant's OIDC configuration, builds the authorization-redirect
 * URL with a signed state, and handles the callback: exchanging the code,
 * verifying the ID token (issuer, audience, expiry, nonce) against the discovered
 * provider metadata, and returning the resolved claims. It satisfies the
 * `IdentityProviderContract`, so it can be introspected like any host driver.
 */
export default class SsoService {
  readonly #deps: SsoServiceDeps

  /**
   * SsoService IS the built-in `oidc` identity provider — it satisfies
   * {@link IdentityProviderContract}. `name`/`contractVersion` let it be
   * introspected like any host driver; alternates live on
   * `identityProviderRegistry`.
   */
  readonly name = 'oidc' as const
  readonly contractVersion = SSO_CONTRACT_VERSION

  constructor(deps: Partial<SsoServiceDeps> = {}) {
    this.#deps = { ...defaultDeps(), ...deps }
  }

  async getConfig(tenantId: string): Promise<TenantSsoConfig | null> {
    return this.#deps.loadEnabledConfig(tenantId)
  }

  async upsertConfig(
    tenantId: string,
    data: {
      clientId: string
      clientSecret: string
      issuerUrl: string
      redirectUri: string
      scopes?: string[]
    }
  ): Promise<TenantSsoConfig> {
    // SSRF guard at WRITE time, not just at fetch time: a stored issuer pointing
    // at a private/metadata host turns every later discovery into a server-side
    // request to internal infrastructure. Reject it before it is ever persisted.
    // Loopback is exempted to match `#discover` (in-process IdP test fixtures opt
    // into it; the SsoController never accepts a loopback issuer from admin
    // input), so only non-loopback private/metadata/non-https issuers are
    // refused here.
    if (!isLoopbackIssuer(data.issuerUrl)) {
      const issuerErr = await this.#deps.validateHostIsPublic(data.issuerUrl)
      if (issuerErr) {
        throw new Error(`Refusing to store an unsafe SSO issuerUrl (${issuerErr}).`)
      }
    }

    return this.#deps.persistConfig(tenantId, {
      provider: 'oidc',
      clientId: data.clientId,
      // Encrypt the IdP client secret at rest (AES-256-GCM) under its own secret
      // class, so its key is domain-separated from webhook signing secrets. A
      // backoffice DB/backup leak must not hand out every tenant's OIDC
      // token-exchange credential in plaintext.
      clientSecret: await this.#deps.encryptSecret(data.clientSecret),
      issuerUrl: data.issuerUrl,
      redirectUri: data.redirectUri,
      scopes: data.scopes ?? ['openid', 'email', 'profile'],
      enabled: true,
    })
  }

  async buildAuthUrl(config: TenantSsoConfig): Promise<string> {
    // Pluggable providers: a non-oidc tenant config delegates to a host driver
    // that owns its own flow end to end. Dormant by default — `upsertConfig`
    // always writes `provider: 'oidc'`, so the OIDC path below is unchanged.
    const provider = config.provider ?? 'oidc'
    if (provider !== 'oidc') {
      const driver = identityProviderRegistry.get(provider)
      if (!driver) {
        throw new Error(
          `SSO provider "${provider}" is not registered. Register an IdentityProvider on ` +
            `identityProviderRegistry, or set the tenant's SSO provider to "oidc".`
        )
      }
      return driver.buildAuthUrl(config)
    }

    const discovery = await this.#discover(config.issuerUrl)
    const state = randomBytes(16).toString('hex')
    const nonce = randomBytes(16).toString('hex')

    await this.#deps.redis.setex(
      `sso:state:${state}`,
      STATE_TTL_SECONDS,
      // Record which provider initiated the flow so the state is unambiguous
      // even once multiple drivers exist.
      JSON.stringify({ tenantId: config.tenantId, nonce, provider })
    )

    return buildAuthorizationUrl(discovery.authorization_endpoint, {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      state,
      nonce,
    })
  }

  async handleCallback(
    state: string,
    code: string
  ): Promise<{ tenantId: string; claims: IdTokenClaims }> {
    // Atomic GETDEL: Redis returns the value AND removes the key in a
    // single command. Without this, a TOCTOU between GET and DEL would
    // let two concurrent callbacks with the same `state` both pass —
    // a CSRF/replay vector in OIDC. Requires Redis >= 6.2.
    const raw = await this.#deps.redis.getdel(`sso:state:${state}`)
    if (!raw) throw new Error('Invalid or expired SSO state')

    // `provider` is present on states written by the current version; older
    // states (pre-versioning) omit it and default to the OIDC path here.
    let parsed: { tenantId: string; nonce: string; provider?: string }
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Corrupted SSO state payload')
    }
    const { tenantId, nonce } = parsed

    // Defense in depth: this method is the built-in OIDC driver's callback and
    // only ever processes states it wrote (always `provider: 'oidc'`; absent ⇒
    // a pre-versioning OIDC state). A state tagged for another provider belongs
    // to that driver's own callback and must not be replayed through OIDC here.
    if (parsed.provider && parsed.provider !== 'oidc') {
      throw new Error(`SSO state belongs to provider "${parsed.provider}", not the OIDC callback`)
    }

    const config = await this.getConfig(tenantId)
    if (!config) throw new Error('SSO not configured for this tenant')

    const discovery = await this.#discover(config.issuerUrl)

    const tokenRes = await this.#deps.fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        // Fail closed: decryptSecret reads strictly under the sso:client_secret
        // class. A plaintext or wrong-context value throws here rather than being
        // sent as the token-exchange credential, so a pre-upgrade row stops the
        // exchange until `tenant:secrets:reencrypt` migrates it.
        client_secret: await this.#deps.decryptSecret(config.clientSecret),
      }),
      // Never follow a redirect on the token POST: the body carries the decrypted
      // OIDC client_secret, so a 3xx from the validated token_endpoint to an
      // attacker host would exfiltrate it past the SSRF guard. A conformant IdP
      // never redirects the token exchange. (jose's createRemoteJWKSet already
      // pins redirect:'manual'; mirror it here.)
      redirect: 'manual',
      signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
    })

    if (tokenRes.status >= 300 && tokenRes.status < 400) {
      throw new Error('OIDC token endpoint attempted a redirect; refusing to follow (SSRF guard)')
    }
    if (!tokenRes.ok) throw new Error('Token exchange failed')
    const tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string }

    if (!tokens.id_token) {
      throw new Error('OIDC token response missing required id_token')
    }

    const claims = await this.#verifyIdToken({
      idToken: tokens.id_token,
      expectedIssuer: discovery.issuer,
      expectedAudience: config.clientId,
      jwksUri: discovery.jwks_uri,
      expectedNonce: nonce,
    })

    return { tenantId, claims }
  }

  /**
   * Verify the id_token's signature against the IdP's JWKS, plus iss/aud/exp
   * (jose checks those when given the matching options). Nonce is checked
   * separately because jose's `jwtVerify` doesn't know about OIDC nonce.
   *
   * Resolves `jose` through the injectable seam (default: a dynamic import) so
   * apps that don't use SSO never pay the dependency cost — the optional peer is
   * only required when this path runs.
   */
  async #verifyIdToken(opts: {
    idToken: string
    expectedIssuer: string
    expectedAudience: string
    jwksUri: string
    expectedNonce: string
  }): Promise<IdTokenClaims> {
    let jose: typeof import('jose')
    try {
      jose = await this.#deps.importJose()
    } catch {
      throw new Error(
        'OIDC verification requires the optional peer dependency `jose`. ' +
          'Install it with `npm i jose` to enable SSO.'
      )
    }

    const jwks = jose.createRemoteJWKSet(new URL(opts.jwksUri))
    const { payload } = await jose.jwtVerify(opts.idToken, jwks, {
      issuer: opts.expectedIssuer,
      audience: opts.expectedAudience,
      clockTolerance: CLOCK_SKEW_SECONDS,
    })

    const claims = payload as unknown as IdTokenClaims
    if (claims.nonce !== opts.expectedNonce) {
      throw new Error('id_token nonce mismatch')
    }
    return claims
  }

  async #discover(issuerUrl: string): Promise<OidcDiscovery> {
    return this.#deps.cacheGetOrSet({
      key: `oidc:discovery:${issuerUrl}`,
      ttl: '3600s',
      factory: async () => {
        // SSRF guard at the fetch boundary. The admin controller validates
        // issuerUrl on upsert, but discover() also runs from buildAuthUrl /
        // handleCallback against a stored value, and from direct service
        // callers. Re-check here. Loopback issuers are exempt (test fixtures
        // opt into an in-process IdP); the SsoController never accepts a
        // loopback issuerUrl from admin input.
        if (!isLoopbackIssuer(issuerUrl)) {
          const issuerErr = await this.#deps.validateHostIsPublic(issuerUrl)
          if (issuerErr) {
            throw new Error(`OIDC discovery refused: unsafe issuerUrl (${issuerErr}).`)
          }
        }
        const base = issuerUrl.replace(/\/$/, '')
        const res = await this.#deps.fetch(`${base}/.well-known/openid-configuration`, {
          // Don't follow redirects: a 3xx from the validated discovery URL to an
          // internal/metadata host would reach it server-side past the SSRF guard
          // (and the body is parsed + partially surfaced in errors).
          redirect: 'manual',
          signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
        })
        if (res.status >= 300 && res.status < 400) {
          throw new Error(
            `OIDC discovery for ${issuerUrl} attempted a redirect; refusing to follow`
          )
        }
        if (!res.ok) throw new Error(`OIDC discovery failed for ${issuerUrl}`)
        const doc = (await res.json()) as Partial<OidcDiscovery>
        if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
          throw new Error(
            `OIDC discovery for ${issuerUrl} is missing required fields ` +
              '(issuer, authorization_endpoint, token_endpoint, jwks_uri).'
          )
        }
        // OpenID Connect Discovery 1.0 section 4.3: the issuer returned in the
        // discovery doc MUST match the URL used to fetch it (modulo a trailing
        // slash). Without this check, an attacker who compromises the discovery
        // host can substitute any iss value and still pass
        // jose.jwtVerify({ issuer: discovery.issuer }) — turning the signature
        // check into a self-consistency check rather than a trust check anchored
        // at admin-configured input.
        const declaredIssuer = doc.issuer.replace(/\/$/, '')
        const requestedIssuer = issuerUrl.replace(/\/$/, '')
        if (declaredIssuer !== requestedIssuer) {
          throw new Error(
            `OIDC discovery for ${issuerUrl} returned a mismatched issuer (${doc.issuer}); ` +
              'refusing to trust this provider.'
          )
        }
        // Defense-in-depth: a compromised or misconfigured IdP could publish a
        // discovery doc whose token_endpoint / jwks_uri points at a private
        // network (loopback, RFC 1918, cloud metadata). Both URLs are fetched
        // server-side by handleCallback() and #verifyIdToken(), so apply the
        // same SSRF guard the admin controller applies to the issuer URL itself.
        //
        // Skip when the issuer itself is loopback — if you've already opted into
        // an in-process IdP (typically only test fixtures do), enforcing
        // public-https on its endpoints would just block the test without
        // changing the threat model. The SsoController never accepts a loopback
        // issuerUrl from admin input, so this only fires for direct service
        // callers (tests, ad-hoc scripts).
        if (!isLoopbackIssuer(issuerUrl)) {
          const tokenErr = await this.#deps.validateHostIsPublic(doc.token_endpoint)
          if (tokenErr) {
            throw new Error(
              `OIDC discovery for ${issuerUrl} returned an unsafe token_endpoint (${tokenErr}).`
            )
          }
          const jwksErr = await this.#deps.validateHostIsPublic(doc.jwks_uri)
          if (jwksErr) {
            throw new Error(
              `OIDC discovery for ${issuerUrl} returned an unsafe jwks_uri (${jwksErr}).`
            )
          }
        }
        return doc as OidcDiscovery
      },
    })
  }
}
