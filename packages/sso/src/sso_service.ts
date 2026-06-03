import TenantSsoConfig from './tenant_sso_config.js'
import { getCache } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  validateExternalHttpsUrl,
  validateResolvedHostIsPublic,
} from '@adonisjs-lasagna/saas-tenancy'
import redis from '@adonisjs/redis/services/main'
import { randomBytes } from 'node:crypto'

interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
}

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

function isLoopbackIssuer(issuerUrl: string): boolean {
  try {
    const u = new URL(issuerUrl)
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

export default class SsoService {
  async getConfig(tenantId: string): Promise<TenantSsoConfig | null> {
    return TenantSsoConfig.query().where('tenant_id', tenantId).where('enabled', true).first()
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
    return TenantSsoConfig.updateOrCreate(
      { tenantId },
      {
        provider: 'oidc',
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        issuerUrl: data.issuerUrl,
        redirectUri: data.redirectUri,
        scopes: data.scopes ?? ['openid', 'email', 'profile'],
        enabled: true,
      }
    )
  }

  async buildAuthUrl(config: TenantSsoConfig): Promise<string> {
    const discovery = await this.discover(config.issuerUrl)
    const state = randomBytes(16).toString('hex')
    const nonce = randomBytes(16).toString('hex')

    await redis.setex(
      `sso:state:${state}`,
      STATE_TTL_SECONDS,
      JSON.stringify({ tenantId: config.tenantId, nonce })
    )

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      nonce,
    })

    return `${discovery.authorization_endpoint}?${params}`
  }

  async handleCallback(
    state: string,
    code: string
  ): Promise<{ tenantId: string; claims: IdTokenClaims }> {
    // Atomic GETDEL: Redis returns the value AND removes the key in a
    // single command. Without this, a TOCTOU between GET and DEL would
    // let two concurrent callbacks with the same `state` both pass —
    // a CSRF/replay vector in OIDC. Requires Redis ≥ 6.2.
    const raw = await redis.getdel(`sso:state:${state}`)
    if (!raw) throw new Error('Invalid or expired SSO state')

    let parsed: { tenantId: string; nonce: string }
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Corrupted SSO state payload')
    }
    const { tenantId, nonce } = parsed

    const config = await this.getConfig(tenantId)
    if (!config) throw new Error('SSO not configured for this tenant')

    const discovery = await this.discover(config.issuerUrl)

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    })

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
   * Imports `jose` dynamically so apps that don't use SSO never pay the
   * dependency cost — the optional peer is only required when this path runs.
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
      jose = await import('jose')
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

  private async discover(issuerUrl: string): Promise<OidcDiscovery> {
    return getCache()
      .namespace('sso')
      .getOrSet({
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
            const issuerErr = await validateResolvedHostIsPublic(issuerUrl)
            if (issuerErr) {
              throw new Error(`OIDC discovery refused: unsafe issuerUrl (${issuerErr}).`)
            }
          }
          const base = issuerUrl.replace(/\/$/, '')
          const res = await fetch(`${base}/.well-known/openid-configuration`)
          if (!res.ok) throw new Error(`OIDC discovery failed for ${issuerUrl}`)
          const doc = (await res.json()) as Partial<OidcDiscovery>
          if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
            throw new Error(
              `OIDC discovery for ${issuerUrl} is missing required fields ` +
                '(issuer, authorization_endpoint, token_endpoint, jwks_uri).'
            )
          }
          // OpenID Connect Discovery 1.0 §4.3: the issuer returned in the
          // discovery doc MUST match the URL used to fetch it (modulo a
          // trailing slash). Without this check, an attacker who compromises
          // the discovery host can substitute any iss value and still pass
          // jose.jwtVerify({ issuer: discovery.issuer }) — turning the
          // signature check into a self-consistency check rather than a
          // trust check anchored at admin-configured input.
          const declaredIssuer = doc.issuer.replace(/\/$/, '')
          const requestedIssuer = issuerUrl.replace(/\/$/, '')
          if (declaredIssuer !== requestedIssuer) {
            throw new Error(
              `OIDC discovery for ${issuerUrl} returned a mismatched issuer (${doc.issuer}); ` +
                'refusing to trust this provider.'
            )
          }
          // Defense-in-depth: a compromised or misconfigured IdP could publish
          // a discovery doc whose token_endpoint / jwks_uri points at a
          // private network (loopback, RFC 1918, cloud metadata). Both URLs
          // are fetched server-side by handleCallback() and #verifyIdToken(),
          // so apply the same SSRF guard the admin controller applies to the
          // issuer URL itself.
          //
          // Skip when the issuer itself is loopback — if you've already opted
          // into an in-process IdP (typically only test fixtures do), enforcing
          // public-https on its endpoints would just block the test without
          // changing the threat model. The SsoController never accepts a
          // loopback issuerUrl from admin input, so this only fires for
          // direct service callers (tests, ad-hoc scripts).
          if (!isLoopbackIssuer(issuerUrl)) {
            const tokenErr = validateExternalHttpsUrl(doc.token_endpoint)
            if (tokenErr) {
              throw new Error(
                `OIDC discovery for ${issuerUrl} returned an unsafe token_endpoint (${tokenErr}).`
              )
            }
            const jwksErr = validateExternalHttpsUrl(doc.jwks_uri)
            if (jwksErr) {
              throw new Error(
                `OIDC discovery for ${issuerUrl} returned an unsafe jwks_uri (${jwksErr}).`
              )
            }
          }
          return doc as OidcDiscovery
        },
      }) as Promise<OidcDiscovery>
  }
}
