import { test } from '@japa/runner'
import { buildAuthorizationUrl, isLoopbackIssuer } from '../../../../src/authorize.js'

/**
 * Package-local runtime signal for the sso satellite, which publishes
 * independently via Changesets. Imports `src/authorize.js` directly: the
 * service module pulls in the Redis service singleton at module scope and is
 * not importable outside an Ignitor, so the testable surface is the pure
 * helpers extracted into authorize.ts.
 */
test.group('sso — buildAuthorizationUrl', () => {
  const base = {
    clientId: 'client-123',
    redirectUri: 'https://app.example.com/sso/callback',
    scopes: ['openid', 'email', 'profile'],
    state: 'state-abc',
    nonce: 'nonce-xyz',
  }

  test('points at the authorization endpoint', ({ assert }) => {
    const url = new URL(buildAuthorizationUrl('https://idp.example.com/authorize', base))
    assert.equal(url.origin + url.pathname, 'https://idp.example.com/authorize')
  })

  test('carries the OIDC authorization-request parameters', ({ assert }) => {
    const url = new URL(buildAuthorizationUrl('https://idp.example.com/authorize', base))
    const q = url.searchParams
    assert.equal(q.get('response_type'), 'code')
    assert.equal(q.get('client_id'), 'client-123')
    assert.equal(q.get('redirect_uri'), 'https://app.example.com/sso/callback')
    assert.equal(q.get('scope'), 'openid email profile')
    assert.equal(q.get('state'), 'state-abc')
    assert.equal(q.get('nonce'), 'nonce-xyz')
  })

  test('space-joins multiple scopes and URL-encodes them', ({ assert }) => {
    const raw = buildAuthorizationUrl('https://idp.example.com/authorize', base)
    // The space separator must be percent-encoded in the query string.
    assert.include(raw, 'scope=openid+email+profile')
  })
})

test.group('sso — isLoopbackIssuer', () => {
  test('is true for loopback hosts', ({ assert }) => {
    assert.isTrue(isLoopbackIssuer('http://localhost:8080/default'))
    assert.isTrue(isLoopbackIssuer('http://127.0.0.1/realm'))
    assert.isTrue(isLoopbackIssuer('http://[::1]:9000'))
  })

  test('is false for a public https issuer', ({ assert }) => {
    assert.isFalse(isLoopbackIssuer('https://login.example.com'))
  })

  test('is false for a malformed URL', ({ assert }) => {
    assert.isFalse(isLoopbackIssuer('not a url'))
    assert.isFalse(isLoopbackIssuer(''))
  })
})
