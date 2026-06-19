import { test } from '@japa/runner'
import SsoService from '../../src/sso_service.js'
import type { SsoServiceDeps } from '../../src/sso_service.js'
import type TenantSsoConfig from '../../src/tenant_sso_config.js'

/**
 * Unit suite for the security-critical SSO flow (B-SSO).
 *
 * `SsoService` concentrates the OIDC guards: the atomic GETDEL of the CSRF
 * state, the SSRF checks on issuer/token_endpoint/jwks_uri, the
 * discovery issuer-mismatch check, and the id_token nonce check. The
 * integration suite (mock-oauth2-server in core) proves the happy path
 * end-to-end, but it would not catch a refactor that quietly dropped one of
 * these guards. These tests pin each guard against injected fakes — no DB, no
 * Redis, no real IdP — so a regression turns a test red instead of opening a
 * hole.
 */

const ISSUER = 'https://idp.example.com'

function discoveryDoc(over: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    ...over,
  }
}

/** A minimal in-memory Redis exposing only getdel/setex. */
function fakeRedis(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    store,
    redis: {
      async getdel(key: string) {
        const v = store.get(key) ?? null
        store.delete(key)
        return v
      },
      async setex(key: string, _ttl: number, value: string) {
        store.set(key, value)
        return 'OK'
      },
    },
  }
}

type FetchHandler = { match: (url: string) => boolean; respond: () => unknown }

/** A fake `fetch` that routes by URL to a list of canned responses. */
function fakeFetch(handlers: FetchHandler[]): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
    const h = handlers.find((x) => x.match(url))
    if (!h) throw new Error(`unexpected fetch: ${url}`)
    return h.respond()
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body }
}

/** A fake `jose` whose jwtVerify returns a fixed payload (or throws). */
function fakeJose(payload: Record<string, unknown>, throwVerify = false) {
  return {
    createRemoteJWKSet: () => ({}),
    jwtVerify: async () => {
      if (throwVerify) throw new Error('signature verification failed')
      return { payload }
    },
  } as unknown as typeof import('jose')
}

const enabledConfig = {
  id: 'cfg-1',
  tenantId: 't-1',
  provider: 'oidc',
  clientId: 'client-123',
  clientSecret: 'enc:secret',
  issuerUrl: ISSUER,
  redirectUri: 'https://app.example.com/sso/callback',
  scopes: ['openid', 'email'],
  enabled: true,
} as unknown as TenantSsoConfig

/**
 * Build an SsoService wired to fakes for the happy path. `over` replaces any
 * dep. `nonce` is the value stored in the state record (and, by default, the
 * one the fake id_token carries back).
 */
function makeService(
  opts: {
    over?: Partial<SsoServiceDeps>
    validateHostIsPublic?: SsoServiceDeps['validateHostIsPublic']
    fetchHandlers?: FetchHandler[]
    jose?: typeof import('jose')
    config?: TenantSsoConfig | null
  } = {}
) {
  const defaultFetch = fakeFetch([
    {
      match: (u) => u.includes('/.well-known/openid-configuration'),
      respond: () => jsonResponse(discoveryDoc()),
    },
    {
      match: (u) => u === `${ISSUER}/token`,
      respond: () => jsonResponse({ id_token: 'fake.jwt.token' }),
    },
  ])

  const deps: Partial<SsoServiceDeps> = {
    redis: fakeRedis().redis,
    fetch: opts.fetchHandlers ? fakeFetch(opts.fetchHandlers) : defaultFetch,
    cacheGetOrSet: (o) => o.factory(),
    validateHostIsPublic: opts.validateHostIsPublic ?? (async () => null),
    loadEnabledConfig: async () => (opts.config === undefined ? enabledConfig : opts.config),
    encryptSecret: (v) => `enc:${v}`,
    decryptSecret: (v) => v.replace(/^enc:/, ''),
    importJose: async () =>
      opts.jose ?? fakeJose({ sub: 'user-1', nonce: 'N1', email: 'u@example.com' }),
    ...opts.over,
  }
  return new SsoService(deps)
}

test.group('SsoService — state GETDEL (CSRF/replay guard)', () => {
  test('consumes the state exactly once; a replay is rejected', async ({ assert }) => {
    const { redis, store } = fakeRedis({
      'sso:state:S1': JSON.stringify({ tenantId: 't-1', nonce: 'N1' }),
    })
    const svc = makeService({ over: { redis } })

    const result = await svc.handleCallback('S1', 'auth-code')
    assert.equal(result.tenantId, 't-1')
    assert.equal(result.claims.sub, 'user-1')
    assert.isFalse(store.has('sso:state:S1'), 'state key was deleted by GETDEL')

    await assert.rejects(
      () => svc.handleCallback('S1', 'auth-code'),
      /Invalid or expired SSO state/
    )
  })

  test('a missing state record is rejected', async ({ assert }) => {
    const { redis } = fakeRedis()
    const svc = makeService({ over: { redis } })
    await assert.rejects(() => svc.handleCallback('nope', 'code'), /Invalid or expired SSO state/)
  })

  test('a corrupted (non-JSON) state payload is rejected', async ({ assert }) => {
    const { redis } = fakeRedis({ 'sso:state:S1': 'not-json{' })
    const svc = makeService({ over: { redis } })
    await assert.rejects(() => svc.handleCallback('S1', 'code'), /Corrupted SSO state payload/)
  })
})

test.group('SsoService — SSRF guards on discovery', () => {
  test('rejects a non-public issuer host', async ({ assert }) => {
    const svc = makeService({
      validateHostIsPublic: async (url) => (url === ISSUER ? 'loopback' : null),
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /unsafe issuerUrl \(loopback\)/)
  })

  test('rejects a discovery doc whose token_endpoint is non-public', async ({ assert }) => {
    const svc = makeService({
      validateHostIsPublic: async (url) => (url.endsWith('/token') ? 'rfc1918' : null),
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /unsafe token_endpoint \(rfc1918\)/)
  })

  test('rejects a discovery doc whose jwks_uri is non-public', async ({ assert }) => {
    const svc = makeService({
      validateHostIsPublic: async (url) => (url.endsWith('/jwks') ? 'metadata' : null),
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /unsafe jwks_uri \(metadata\)/)
  })

  test('a loopback issuer is exempt from the SSRF guard (in-process test IdP)', async ({
    assert,
  }) => {
    const loopbackIssuer = 'http://127.0.0.1:9000'
    let validatorCalled = false
    const svc = makeService({
      validateHostIsPublic: async () => {
        validatorCalled = true
        return 'should-not-be-called'
      },
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () =>
            jsonResponse(
              discoveryDoc({
                issuer: loopbackIssuer,
                authorization_endpoint: `${loopbackIssuer}/authorize`,
                token_endpoint: `${loopbackIssuer}/token`,
                jwks_uri: `${loopbackIssuer}/jwks`,
              })
            ),
        },
      ],
    })
    const url = await svc.buildAuthUrl({
      ...enabledConfig,
      issuerUrl: loopbackIssuer,
    } as TenantSsoConfig)
    assert.isFalse(validatorCalled, 'public-host validator is skipped for a loopback issuer')
    assert.include(url, `${loopbackIssuer}/authorize`)
  })
})

test.group('SsoService — discovery integrity', () => {
  test('rejects an issuer that does not match the requested URL', async ({ assert }) => {
    const svc = makeService({
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () => jsonResponse(discoveryDoc({ issuer: 'https://evil.example.com' })),
        },
      ],
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /mismatched issuer/)
  })

  test('rejects a discovery doc missing required fields', async ({ assert }) => {
    const svc = makeService({
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () => jsonResponse({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/a` }),
        },
      ],
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /missing required fields/)
  })

  test('rejects a non-200 discovery response', async ({ assert }) => {
    const svc = makeService({
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () => jsonResponse({}, false),
        },
      ],
    })
    await assert.rejects(() => svc.buildAuthUrl(enabledConfig), /OIDC discovery failed/)
  })
})

test.group('SsoService — callback token + id_token verification', () => {
  function withState() {
    return fakeRedis({ 'sso:state:S1': JSON.stringify({ tenantId: 't-1', nonce: 'N1' }) })
  }

  test('rejects when the tenant has no SSO config', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({ over: { redis }, config: null })
    await assert.rejects(() => svc.handleCallback('S1', 'code'), /SSO not configured/)
  })

  test('rejects a failed token exchange', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({
      over: { redis },
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () => jsonResponse(discoveryDoc()),
        },
        {
          match: (u) => u === `${ISSUER}/token`,
          respond: () => jsonResponse({ error: 'invalid_grant' }, false),
        },
      ],
    })
    await assert.rejects(() => svc.handleCallback('S1', 'code'), /Token exchange failed/)
  })

  test('rejects a token response with no id_token', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({
      over: { redis },
      fetchHandlers: [
        {
          match: (u) => u.includes('/.well-known/openid-configuration'),
          respond: () => jsonResponse(discoveryDoc()),
        },
        {
          match: (u) => u === `${ISSUER}/token`,
          respond: () => jsonResponse({ access_token: 'at' }),
        },
      ],
    })
    await assert.rejects(() => svc.handleCallback('S1', 'code'), /missing required id_token/)
  })

  test('rejects an id_token whose nonce does not match the stored state', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({
      over: { redis },
      jose: fakeJose({ sub: 'user-1', nonce: 'DIFFERENT', email: 'u@example.com' }),
    })
    await assert.rejects(() => svc.handleCallback('S1', 'code'), /nonce mismatch/)
  })

  test('surfaces a clear error when the optional `jose` peer is absent', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({
      over: {
        redis,
        importJose: async () => {
          throw new Error("Cannot find package 'jose'")
        },
      },
    })
    await assert.rejects(
      () => svc.handleCallback('S1', 'code'),
      /requires the optional peer dependency `jose`/
    )
  })

  test('returns tenantId + verified claims on the happy path', async ({ assert }) => {
    const { redis } = withState()
    const svc = makeService({ over: { redis } })
    const { tenantId, claims } = await svc.handleCallback('S1', 'code')
    assert.equal(tenantId, 't-1')
    assert.equal(claims.sub, 'user-1')
    assert.equal(claims.email, 'u@example.com')
  })
})
