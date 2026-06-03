import { test } from '@japa/runner'
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

// SSO/OIDC interop against a real OIDC mock server (CI provides
// ghcr.io/navikt/mock-oauth2-server). Skipped unless MOCK_OIDC_BASE_URL
// is set. Catches drift in the discovery/JWKS/token-endpoint contract
// that the in-spec fake IdP (sso_oidc_flow.spec.ts) can't surface.
// Full token-exchange coverage stays in sso_oidc_flow.spec.ts — the
// mock can't embed our cached nonce.
const ISSUER = process.env.MOCK_OIDC_BASE_URL
const SHOULD_RUN = typeof ISSUER === 'string' && ISSUER.length > 0

test.group('SsoService — real OIDC server interop', (group) => {
  const svc = new SsoService()
  const cleanup: string[] = []

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
      clientSecret: 'shhh-test',
      issuerUrl: ISSUER!,
      redirectUri: 'http://app.test/cb',
    })
    return { tenantId: t.id, clientId }
  }

  test('discovery doc is reachable and lists the required endpoints', async ({ assert }) => {
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`)
    assert.equal(res.status, 200, 'discovery endpoint must be reachable')
    const doc: any = await res.json()
    assert.equal(
      doc.issuer.replace(/\/$/, ''),
      ISSUER!.replace(/\/$/, ''),
      'issuer in the doc must match the URL it was fetched from'
    )
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      assert.isString(doc[field], `discovery doc missing required field "${field}"`)
    }
  }).skip(!SHOULD_RUN, 'MOCK_OIDC_BASE_URL not set — real OIDC interop skipped')

  test('JWKS endpoint returns a parseable key set with at least one signing key', async ({
    assert,
  }) => {
    const doc: any = await fetch(`${ISSUER}/.well-known/openid-configuration`).then((r) => r.json())
    const jwks: any = await fetch(doc.jwks_uri).then((r) => r.json())
    assert.isArray(jwks.keys, 'JWKS must expose a `keys` array')
    assert.isAtLeast(jwks.keys.length, 1, 'JWKS must contain at least one key')
    // Every key needs a `kty` at minimum — anything else and `jose.createRemoteJWKSet`
    // refuses to use it.
    for (const k of jwks.keys) {
      assert.isString(k.kty, 'every JWKS key must carry a `kty`')
    }
  }).skip(!SHOULD_RUN, 'MOCK_OIDC_BASE_URL not set — real OIDC interop skipped')

  test('buildAuthUrl() composes a spec-compliant authorize URL against the real discovery doc', async ({
    assert,
  }) => {
    const { tenantId, clientId } = await freshTenantWithSso()
    const cfg = (await svc.getConfig(tenantId))!
    const url = await svc.buildAuthUrl(cfg)

    // The URL must point at the issuer's authorize endpoint and carry
    // every OIDC-mandated param.
    const parsed = new URL(url)
    const doc: any = await fetch(`${ISSUER}/.well-known/openid-configuration`).then((r) => r.json())
    const expectedHost = new URL(doc.authorization_endpoint).host
    assert.equal(parsed.host, expectedHost, 'auth URL must use the issuer-declared host')
    assert.equal(parsed.searchParams.get('response_type'), 'code')
    assert.equal(parsed.searchParams.get('client_id'), clientId)
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://app.test/cb')
    assert.isString(parsed.searchParams.get('state'), 'state must be present (CSRF guard)')
    assert.isString(parsed.searchParams.get('nonce'), 'nonce must be present (replay guard)')
    assert.match(
      parsed.searchParams.get('scope') ?? '',
      /\bopenid\b/,
      'scope must request `openid` for OIDC'
    )
  }).skip(!SHOULD_RUN, 'MOCK_OIDC_BASE_URL not set — real OIDC interop skipped')

  test('handleCallback() rejects an unknown state — CSRF guard fires against the real IdP', async ({
    assert,
  }) => {
    await freshTenantWithSso()
    // No state was ever stored under this random value → the CSRF guard
    // must reject it BEFORE we ever touch the IdP's token endpoint.
    await assert.rejects(
      () => svc.handleCallback('this-state-was-never-issued', 'whatever-code'),
      /Invalid or expired SSO state/i
    )
  }).skip(!SHOULD_RUN, 'MOCK_OIDC_BASE_URL not set — real OIDC interop skipped')

  test('buildAuthUrl() throws cleanly when the discovery URL is unreachable', async ({
    assert,
  }) => {
    // Pointing at a port the IdP doesn't listen on must fail the
    // discovery fetch loudly — it's the same network failure
    // production sees when an IdP host goes down, and the service
    // must surface it instead of producing a half-baked auth URL.
    // (`mock-oauth2-server` itself echoes whatever issuer is requested,
    // so the "discovery returned a wrong issuer" branch is covered
    // by `sso_oidc_flow.spec.ts` where we control the IdP end-to-end.)
    const t = await createTestTenant()
    cleanup.push(t.id)
    await svc.upsertConfig(t.id, {
      clientId: 'client-x',
      clientSecret: 'shhh',
      issuerUrl: 'http://127.0.0.1:1', // reserved port — always closed
      redirectUri: 'http://app.test/cb',
    })
    const cfg = (await svc.getConfig(t.id))!
    // Bentocache wraps the inner fetch error in "Factory has thrown an
    // error"; the SsoService's own discovery branch produces
    // "OIDC discovery failed"; native fetch can produce ECONNREFUSED.
    // Any of those proves the call did NOT silently succeed.
    await assert.rejects(
      () => svc.buildAuthUrl(cfg),
      /discovery|fetch|connect|ECONNREFUSED|Factory has thrown/i
    )
  }).skip(!SHOULD_RUN, 'MOCK_OIDC_BASE_URL not set — real OIDC interop skipped')
})
