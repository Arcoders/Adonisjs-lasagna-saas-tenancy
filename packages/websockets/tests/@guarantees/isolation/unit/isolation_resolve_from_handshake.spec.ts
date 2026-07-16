import { test } from '@japa/runner'
import { resolveTenantIdFromHandshake } from '../../../../src/resolve_from_handshake.js'
import type { IoHandshake } from '../../../../src/types.js'

const UUID = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'

function handshake(overrides: Partial<IoHandshake> = {}): IoHandshake {
  return { auth: {}, headers: {}, query: {}, ...overrides }
}

test.group('resolveTenantIdFromHandshake', () => {
  test('reads auth.tenantId by default', ({ assert }) => {
    assert.equal(resolveTenantIdFromHandshake(handshake({ auth: { tenantId: UUID } })), UUID)
  })

  test('falls back to the x-tenant-id header', ({ assert }) => {
    assert.equal(
      resolveTenantIdFromHandshake(handshake({ headers: { 'x-tenant-id': UUID } })),
      UUID
    )
  })

  test('auth takes precedence over header', ({ assert }) => {
    const result = resolveTenantIdFromHandshake(
      handshake({ auth: { tenantId: UUID }, headers: { 'x-tenant-id': UUID2 } })
    )
    assert.equal(result, UUID)
  })

  test('honours a custom header key (lowercased lookup)', ({ assert }) => {
    const result = resolveTenantIdFromHandshake(handshake({ headers: { 'x-org': UUID } }), {
      authKey: false,
      headerKey: 'X-Org',
    })
    assert.equal(result, UUID)
  })

  test('reads a query param only when queryKey is configured', ({ assert }) => {
    assert.isUndefined(resolveTenantIdFromHandshake(handshake({ query: { tenant_id: UUID } })))
    assert.equal(
      resolveTenantIdFromHandshake(handshake({ query: { tenant_id: UUID } }), {
        authKey: false,
        queryKey: 'tenant_id',
      }),
      UUID
    )
  })

  test('derives the id from a Host subdomain when enabled', ({ assert }) => {
    const result = resolveTenantIdFromHandshake(
      handshake({ headers: { host: `${UUID}.app.com:443` } }),
      { authKey: false, headerKey: false, subdomain: true, baseDomain: 'app.com' }
    )
    assert.equal(result, UUID)
  })

  test('returns undefined when no source carries an id', ({ assert }) => {
    assert.isUndefined(resolveTenantIdFromHandshake(handshake()))
  })

  test('rejects a non-UUID candidate', ({ assert }) => {
    assert.isUndefined(
      resolveTenantIdFromHandshake(handshake({ auth: { tenantId: 'not-a-uuid' } }))
    )
  })

  test('disabling authKey with false skips the auth source', ({ assert }) => {
    const result = resolveTenantIdFromHandshake(
      handshake({ auth: { tenantId: UUID }, headers: { 'x-tenant-id': UUID2 } }),
      { authKey: false }
    )
    assert.equal(result, UUID2)
  })

  test('coerces an array header value to its first entry', ({ assert }) => {
    assert.equal(
      resolveTenantIdFromHandshake(handshake({ headers: { 'x-tenant-id': [UUID, UUID2] } })),
      UUID
    )
  })
})
