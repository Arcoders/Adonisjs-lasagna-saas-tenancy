import { test } from '@japa/runner'
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'

test.group('SsoService (integration)', (group) => {
  const svc = new SsoService()
  const cleanup: string[] = []

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await TenantSsoConfig.query().where('tenant_id', id).delete()
      await destroyTestTenant(id)
    }
  })

  test('getConfig() returns null before any upsert', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const cfg = await svc.getConfig(t.id)
    assert.isNull(cfg)
  })

  test('upsertConfig() creates a row with provider=oidc and the provided fields', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const written = await svc.upsertConfig(t.id, {
      clientId: 'abc-client',
      clientSecret: 'secret-shh',
      issuerUrl: 'https://example.okta.com',
      redirectUri: 'https://app.example.test/cb',
      scopes: ['openid', 'profile', 'email'],
    })

    assert.equal(written.provider, 'oidc')
    assert.equal(written.clientId, 'abc-client')
    assert.equal(written.issuerUrl, 'https://example.okta.com')
    assert.deepEqual(written.scopes, ['openid', 'profile', 'email'])
    assert.isTrue(written.enabled)
  })

  test('getConfig() filters by enabled=true', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.upsertConfig(t.id, {
      clientId: 'cid',
      clientSecret: 'csec',
      issuerUrl: 'https://example.okta.com',
      redirectUri: 'https://app.example.test/cb',
    })
    const cfg = await svc.getConfig(t.id)
    assert.isNotNull(cfg)
    assert.equal(cfg!.clientId, 'cid')

    // Disable the row directly and verify getConfig returns null.
    await TenantSsoConfig.query().where('tenant_id', t.id).update({ enabled: false })
    const after = await svc.getConfig(t.id)
    assert.isNull(after, 'getConfig should ignore disabled SSO rows')
  })

  test('upsertConfig() defaults scopes to openid/email/profile when omitted', async ({
    assert,
  }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const row = await svc.upsertConfig(t.id, {
      clientId: 'cid',
      clientSecret: 'csec',
      issuerUrl: 'https://example.okta.com',
      redirectUri: 'https://app.example.test/cb',
    })
    assert.deepEqual(row.scopes, ['openid', 'email', 'profile'])
  })

  test('upsertConfig() called twice updates the row in place', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.upsertConfig(t.id, {
      clientId: 'first',
      clientSecret: 's1',
      issuerUrl: 'https://first.okta.com',
      redirectUri: 'https://app.example.test/cb',
    })
    await svc.upsertConfig(t.id, {
      clientId: 'second',
      clientSecret: 's2',
      issuerUrl: 'https://second.okta.com',
      redirectUri: 'https://app.example.test/cb',
    })

    const rows = await TenantSsoConfig.query().where('tenant_id', t.id)
    assert.lengthOf(rows, 1, 'no duplicate rows')
    assert.equal(rows[0].clientId, 'second')
    assert.equal(rows[0].issuerUrl, 'https://second.okta.com')
  })

  test('SSO config is isolated between tenants', async ({ assert }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    cleanup.push(a.id, b.id)

    await svc.upsertConfig(a.id, {
      clientId: 'a-id',
      clientSecret: 'a-sec',
      issuerUrl: 'https://a.okta.com',
      redirectUri: 'https://a.test/cb',
    })

    const ra = await svc.getConfig(a.id)
    const rb = await svc.getConfig(b.id)
    assert.equal(ra!.clientId, 'a-id')
    assert.isNull(rb, 'tenant B should not see tenant A SSO config')
  })
})
