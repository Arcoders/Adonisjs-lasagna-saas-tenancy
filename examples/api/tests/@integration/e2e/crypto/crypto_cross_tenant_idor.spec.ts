import { test } from '@japa/runner'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * Crypto E2E: hostile cross-tenant IDOR through the API layer.
 *
 * The isolation proofs elsewhere read the DB directly; this one attacks through the
 * booted controllers, the way a real adversary would. Authenticated as tenant B, it
 * tries to read and to shred tenant A's secret, and asserts denial end to end. It
 * also proves the key material never crosses: A's wrapped DEK is physically absent
 * from B's schema, so even a B-side DB compromise cannot open A's ciphertext.
 */
test.group('crypto: hostile cross-tenant IDOR (real HTTP)', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('tenant B cannot read or shred tenant A’s secret; A’s DEK never lands in B', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client, { plan: 'pro' })
    const b = await createInstalledTenant(client, { plan: 'pro' })

    // A stores a secret under subject 'renter-A'.
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', a.id)
      .json({ subject: 'renter-A', secret: 'A-only-passport' })
      .then((r) => r.assertStatus(201))

    // B asks for A's subject: not found, because B's schema has no such row (structural).
    const bRead = await client.get('/demo/secure-notes/renter-A').header('x-tenant-id', b.id)
    bRead.assertStatus(404)
    assert.notInclude(JSON.stringify(bRead.body()), 'A-only-passport')

    // B tries to shred A's subject, but it can only ever reach B's own (empty) schema,
    // so A's DEK is untouched. (A refused or absent-DEK shred is fine; the point is
    // that it cannot affect A.)
    await client.post('/demo/secure-notes/renter-A/shred').header('x-tenant-id', b.id)

    // A still reads its own secret; B's request could not erase it.
    const aRead = await client.get('/demo/secure-notes/renter-A').header('x-tenant-id', a.id)
    aRead.assertStatus(200)
    assert.equal(aRead.body().secret, 'A-only-passport')

    // The wrapped DEK lives only in A's schema. B holds zero, so A's key never leaked.
    const connA = (await Tenant.findOrFail(a.id)).getConnection()
    const connB = (await Tenant.findOrFail(b.id)).getConnection()
    const aDeks = await connA.rawQuery('SELECT count(*)::int AS n FROM crypto_wrapped_deks')
    const bDeks = await connB.rawQuery('SELECT count(*)::int AS n FROM crypto_wrapped_deks')
    assert.isAbove(aDeks.rows[0].n, 0, 'A provisioned its own wrapped DEK')
    assert.equal(bDeks.rows[0].n, 0, 'B holds zero wrapped DEKs — A’s key is absent from B')
  })

  test('the same subject id in both tenants derives independent secrets (no cross-open)', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client, { plan: 'pro' })
    const b = await createInstalledTenant(client, { plan: 'pro' })

    // Identical subject and plaintext in both tenants. The DEKs are per-tenant, so the
    // ciphertexts diverge and neither tenant can open the other's.
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', a.id)
      .json({ subject: 'shared', secret: 'same-value' })
      .then((r) => r.assertStatus(201))
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', b.id)
      .json({ subject: 'shared', secret: 'same-value' })
      .then((r) => r.assertStatus(201))

    const connA = (await Tenant.findOrFail(a.id)).getConnection()
    const connB = (await Tenant.findOrFail(b.id)).getConnection()
    const ctA = (
      await connA.rawQuery('SELECT secret FROM secure_notes WHERE subject = ?', ['shared'])
    ).rows[0].secret as string
    const ctB = (
      await connB.rawQuery('SELECT secret FROM secure_notes WHERE subject = ?', ['shared'])
    ).rows[0].secret as string

    assert.isTrue(ctA.startsWith('enc_v2:') && ctB.startsWith('enc_v2:'))
    assert.notEqual(ctA, ctB, 'independent per-tenant DEKs (and random IVs) diverge')

    // Both still decrypt for their own tenant.
    await client
      .get('/demo/secure-notes/shared')
      .header('x-tenant-id', a.id)
      .then((r) => assert.equal(r.body().secret, 'same-value'))
    await client
      .get('/demo/secure-notes/shared')
      .header('x-tenant-id', b.id)
      .then((r) => assert.equal(r.body().secret, 'same-value'))
  })

  test('the authorizeTenantAccess seam closes the IDOR when the principal-tenant mismatches (403)', async ({
    client,
  }) => {
    const a = await createInstalledTenant(client, { plan: 'pro' })
    const b = await createInstalledTenant(client, { plan: 'pro' })

    // A caller whose authenticated principal belongs to B, but who resolves tenant A
    // by swapping the x-tenant-id header, is refused by the membership gate before the
    // crypto controller ever runs. This is a real-HTTP proof of the IDOR firewall.
    const denied = await client
      .get('/demo/secure-notes/anything')
      .header('x-tenant-id', a.id)
      .header('x-test-principal-tenant', b.id)
    denied.assertStatus(403)

    // The matching principal passes the gate (404 = reached the controller, no such note).
    const allowed = await client
      .get('/demo/secure-notes/anything')
      .header('x-tenant-id', a.id)
      .header('x-test-principal-tenant', a.id)
    allowed.assertStatus(404)
  })
})
