import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose'
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
import redis from '@adonisjs/redis/services/main'
import { createTestTenant, destroyTestTenant } from '@adonisjs-lasagna/satellite-test-kit/testing'

interface FakeIdpHandle {
  baseUrl: string
  publicJwk: JWK
  privateKey: CryptoKey
  /**
   * What the next /token request will return as id_token. The test mutates
   * this to simulate happy-path / tampering / expired tokens.
   */
  setIdToken: (token: string) => void
  /** Forced response status for /token (default 200). */
  setTokenStatus: (code: number) => void
  /**
   * Override the `issuer` value returned by the discovery document. Defaults
   * to the IdP's own base URL (the OIDC-spec-compliant value). Used to test
   * that the service rejects mismatched issuers.
   */
  setDiscoveryIssuer: (issuer: string | null) => void
  /** Stop the HTTP server. */
  close: () => Promise<void>
}

async function startFakeIdp(): Promise<FakeIdpHandle> {
  // jose 6 defaults generateKeyPair to extractable: false; exportJWK(publicKey)
  // below needs an extractable key or it throws at runtime.
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'test-key-1'
  publicJwk.alg = 'RS256'
  publicJwk.use = 'sig'

  let nextIdToken = ''
  let tokenStatus = 200
  let discoveryIssuerOverride: string | null = null

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname === '/.well-known/openid-configuration') {
      const base = `http://${req.headers.host}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          issuer: discoveryIssuerOverride ?? base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
          jwks_uri: `${base}/jwks`,
        })
      )
      return
    }
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [publicJwk] }))
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      res.writeHead(tokenStatus, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id_token: nextIdToken,
          access_token: 'fake-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    baseUrl,
    publicJwk,
    privateKey,
    setIdToken: (t) => {
      nextIdToken = t
    },
    setTokenStatus: (c) => {
      tokenStatus = c
    },
    setDiscoveryIssuer: (i) => {
      discoveryIssuerOverride = i
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  }
}

interface SignArgs {
  privateKey: CryptoKey
  iss: string
  aud: string
  nonce?: string
  expiresIn?: string | number
  sub?: string
  extra?: Record<string, unknown>
}

async function signIdToken(args: SignArgs): Promise<string> {
  const builder = new SignJWT({
    ...(args.extra ?? {}),
    ...(args.nonce ? { nonce: args.nonce } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(args.iss)
    .setAudience(args.aud)
    .setSubject(args.sub ?? 'user-123')
  if (args.expiresIn !== undefined) builder.setExpirationTime(args.expiresIn)
  else builder.setExpirationTime('5m')
  return builder.sign(args.privateKey)
}

/**
 * Pulls the `state` and `nonce` query params out of the auth URL the service
 * builds. We need both to drive the callback path through the same code that
 * a real browser-redirected callback would hit.
 */
function extractStateAndNonce(authUrl: string): { state: string; nonce: string } {
  const u = new URL(authUrl)
  const state = u.searchParams.get('state') ?? ''
  const nonce = u.searchParams.get('nonce') ?? ''
  return { state, nonce }
}

test.group('SsoService — OIDC flow with fake IdP', (group) => {
  const svc = new SsoService()
  let idp: FakeIdpHandle
  const cleanup: string[] = []

  group.setup(async () => {
    idp = await startFakeIdp()
  })

  group.teardown(async () => {
    await idp.close()
  })

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await TenantSsoConfig.query().where('tenant_id', id).delete()
      await destroyTestTenant(id)
    }
  })

  async function freshTenantWithSso(): Promise<{ tenantId: string; clientId: string }> {
    const t = await createTestTenant()
    cleanup.push(t.id)
    const clientId = `client-${t.id.slice(0, 8)}`
    await svc.upsertConfig(t.id, {
      clientId,
      clientSecret: 'shhh',
      issuerUrl: idp.baseUrl,
      redirectUri: 'http://app.test/cb',
    })
    return { tenantId: t.id, clientId }
  }

  test('happy path: signed id_token with valid iss/aud/exp/nonce → claims returned', async ({
    assert,
  }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce,
        extra: { email: 'user@example.test' },
      })
    )

    const result = await svc.handleCallback(state, 'fake-code')
    assert.equal(result.tenantId, tenantId)
    assert.equal(result.claims.iss, idp.baseUrl)
    assert.equal(result.claims.email, 'user@example.test')
  })

  test('token exchange fails closed when the stored client_secret is not ciphertext for its class', async ({
    assert,
  }) => {
    // A pre-upgrade row whose client_secret is plaintext (or was encrypted
    // under the legacy shared context) must fail the strict, class-bound read
    // rather than be sent as the token-exchange credential. The happy-path test
    // above is the positive control (a correctly-classed ciphertext succeeds).
    const { tenantId, clientId } = await freshTenantWithSso()
    await TenantSsoConfig.query()
      .where('tenant_id', tenantId)
      .update({ client_secret: 'plaintext-never-migrated' })

    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)
    idp.setIdToken(
      await signIdToken({ privateKey: idp.privateKey, iss: idp.baseUrl, aud: clientId, nonce })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'), /ciphertext/i)
  })

  test('rejects token with wrong issuer', async ({ assert }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: 'http://evil.example/',
        aud: clientId,
        nonce,
      })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'))
  })

  test('rejects token with wrong audience', async ({ assert }) => {
    const { tenantId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: 'someone-else',
        nonce,
      })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'))
  })

  test('rejects expired token', async ({ assert }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    // Anchor exp well outside the 60s clock-tolerance window.
    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce,
        expiresIn: Math.floor(Date.now() / 1000) - 600,
      })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'))
  })

  test('rejects token with mismatched nonce', async ({ assert }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce: 'attacker-replayed-nonce',
      })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'), /nonce/i)
  })

  test('rejects token signed by an unrelated key (signature failure)', async ({ assert }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    // Sign with a fresh key the IdP does NOT publish via /jwks.
    const { privateKey: rogueKey } = await generateKeyPair('RS256')
    idp.setIdToken(
      await signIdToken({
        privateKey: rogueKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce,
      })
    )

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'))
  })

  test('state can only be used once (replay rejected)', async ({ assert }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce,
      })
    )

    await svc.handleCallback(state, 'fake-code')
    await assert.rejects(
      () => svc.handleCallback(state, 'fake-code'),
      /invalid or expired sso state/i
    )
  })

  test('concurrent callbacks with the same state — exactly one wins (atomic state consumption)', async ({
    assert,
  }) => {
    // Pre-fix this would TOCTOU: GET returns the same value to both
    // callers, both pass the !raw check, both proceed to validate the
    // (identical) id_token and resolve. Post-fix uses GETDEL so only
    // one caller observes a value; the other sees null and rejects.
    // This is the load-bearing test for SSO state replay protection.
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state, nonce } = extractStateAndNonce(url)

    idp.setIdToken(
      await signIdToken({
        privateKey: idp.privateKey,
        iss: idp.baseUrl,
        aud: clientId,
        nonce,
      })
    )

    const results = await Promise.allSettled([
      svc.handleCallback(state, 'fake-code'),
      svc.handleCallback(state, 'fake-code'),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    assert.equal(
      fulfilled.length,
      1,
      `exactly one concurrent callback must win, got ${fulfilled.length}/2`
    )
    assert.equal(rejected.length, 1)
    assert.match(
      String((rejected[0] as PromiseRejectedResult).reason?.message ?? rejected[0].reason),
      /invalid or expired sso state/i
    )
  })

  test('rejects discovery doc whose issuer does not match the requested issuerUrl', async ({
    assert,
  }) => {
    // Spin a dedicated IdP so the polluted discovery doc never lands in the
    // shared BentoCache key used by the other tests in this group.
    const badIdp = await startFakeIdp()
    try {
      const t = await createTestTenant()
      cleanup.push(t.id)
      await svc.upsertConfig(t.id, {
        clientId: 'mismatch-client',
        clientSecret: 'shhh',
        issuerUrl: badIdp.baseUrl,
        redirectUri: 'http://app.test/cb',
      })
      const cfg = (await svc.getConfig(t.id))!

      badIdp.setDiscoveryIssuer('https://attacker.example/')
      // BentoCache's getOrSet wraps factory exceptions in a generic
      // "Factory has thrown an error", so walk the cause chain to assert
      // on the underlying message we throw from discover().
      let caught: unknown = null
      try {
        await svc.buildAuthUrl(cfg)
      } catch (e) {
        caught = e
      }
      assert.isNotNull(caught, 'buildAuthUrl must reject on issuer mismatch')
      const messages: string[] = []
      let cur: any = caught
      while (cur) {
        if (typeof cur.message === 'string') messages.push(cur.message)
        cur = cur.cause
      }
      assert.match(messages.join(' | '), /mismatched issuer/i)
    } finally {
      await badIdp.close()
    }
  })

  test('rejects token endpoint response missing id_token', async ({ assert }) => {
    const { tenantId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)
    const { state } = extractStateAndNonce(url)

    idp.setIdToken('') // empty, so the service must reject

    await assert.rejects(() => svc.handleCallback(state, 'fake-code'), /id_token/i)
    await redis.del(`sso:state:${state}`).catch(() => {})
  })
})
