import { test } from '@japa/runner'
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantBranding } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { createTestTenant, destroyTestTenant } from '../../../integration/helpers/tenant.js'

test.group('BrandingService (integration)', (group) => {
  const svc = new BrandingService()
  const cleanup: string[] = []

  group.each.teardown(async () => {
    while (cleanup.length) {
      const id = cleanup.pop()!
      await TenantBranding.query().where('tenant_id', id).delete()
      await destroyTestTenant(id)
    }
  })

  test('getForTenant() returns null before any upsert', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const row = await svc.getForTenant(t.id)
    assert.isNull(row)
  })

  test('upsert() creates a row, getForTenant() reads it back', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const written = await svc.upsert(t.id, {
      fromName: 'Acme Inc.',
      fromEmail: 'no-reply@acme.test',
      primaryColor: '#FF00FF',
      supportUrl: 'https://acme.test/help',
    })
    assert.equal(written.fromName, 'Acme Inc.')

    const read = await svc.getForTenant(t.id)
    assert.isNotNull(read)
    assert.equal(read!.fromName, 'Acme Inc.')
    assert.equal(read!.primaryColor, '#FF00FF')
  })

  test('upsert() called twice updates the existing row (no duplicates)', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    await svc.upsert(t.id, { fromName: 'First Name' })
    await svc.upsert(t.id, { fromName: 'Second Name', primaryColor: '#000000' })

    const all = await TenantBranding.query().where('tenant_id', t.id)
    assert.lengthOf(all, 1)
    assert.equal(all[0].fromName, 'Second Name')
    assert.equal(all[0].primaryColor, '#000000')
  })

  test('renderEmailContext() applies sane defaults for missing branding', ({ assert }) => {
    const ctx = svc.renderEmailContext(null)
    assert.isString(ctx.fromName)
    assert.isString(ctx.fromEmail)
    assert.isString(ctx.primaryColor)
  })

  test('renderEmailContext() returns persisted values when present', async ({ assert }) => {
    const t = await createTestTenant()
    cleanup.push(t.id)

    const row = await svc.upsert(t.id, {
      fromName: 'Tenant-A',
      fromEmail: 'a@e2e.test',
      primaryColor: '#123456',
    })
    const ctx = svc.renderEmailContext(row)
    assert.equal(ctx.fromName, 'Tenant-A')
    assert.equal(ctx.fromEmail, 'a@e2e.test')
    assert.equal(ctx.primaryColor, '#123456')
  })

  test('branding rows are isolated between tenants', async ({ assert }) => {
    const a = await createTestTenant()
    const b = await createTestTenant()
    cleanup.push(a.id, b.id)

    await svc.upsert(a.id, { fromName: 'A-Co' })
    await svc.upsert(b.id, { fromName: 'B-Co' })

    const ra = await svc.getForTenant(a.id)
    const rb = await svc.getForTenant(b.id)
    assert.equal(ra!.fromName, 'A-Co')
    assert.equal(rb!.fromName, 'B-Co')
  })
})
