import { test } from '@japa/runner'
import { realms, authHeaders } from './_helpers.js'

/**
 * Renter PII protection (Law 09-08 / GDPR erasure), end to end. A renter's
 * identity fields are encrypted at rest and searchable only through a blind
 * index; exercising the erasure right crypto-shreds the DEK, after which the
 * record fails closed (410 Gone) rather than surfacing inert ciphertext, and the
 * blind index no longer matches.
 *
 * Self-contained: it creates its own throwaway renter and hard-deletes the row
 * on teardown, so the seeded demo data stays pristine.
 */
test.group('security — renter PII crypto-shred', (group) => {
  const email = `e2e-shred-${Date.now()}@test.invalid`
  const cin = 'ZZ999888'

  group.teardown(async () => {
    const { tenancy } = await import('@adonisjs-lasagna/saas-tenancy')
    const { default: Tenant } = await import('#app/models/backoffice/tenant')
    const { default: Customer } = await import('#app/models/tenant_scoped/customer')
    const acme = await Tenant.query().where('custom_domain', 'acme.localhost').firstOrFail()
    // Raw delete (no model hydration → no decrypt hook, so a shredded row deletes
    // cleanly). email is a plaintext column and survives the shred.
    await tenancy.run(acme, async () => {
      await Customer.query().where('email', email).delete()
    })
  })

  test('PII is encrypted, blind-index searchable, and unreadable after erasure', async ({
    client,
    assert,
  }) => {
    const { acme } = await realms(client)
    const h = authHeaders(acme)

    // Create a renter carrying identity PII.
    const created = await client
      .post('/customers')
      .headers(h)
      .json({ fullName: 'Erasure Test', email, cin, driverLicense: 'ZZ111222' })
    created.assertStatus(201)
    const customerId: string = created.body().customer.id
    assert.exists(customerId)

    // The detail view decrypts the CIN back to plaintext.
    const before = await client.get(`/customers/${customerId}`).headers(h)
    before.assertStatus(200)
    assert.equal(before.body().customer.cin, cin)

    // Equality search resolves the CIN to its blind index (never decrypts).
    const search = await client.post('/customers/search').headers(h).json({ cin })
    search.assertStatus(200)
    assert.isAtLeast(search.body().matches.length, 1)

    // Exercise the erasure right → crypto-shred destroys the renter's DEK.
    const shred = await client.post(`/customers/${customerId}/shred`).headers(h)
    shred.assertStatus(200)

    // Re-reading the shredded renter fails closed (410 Gone), not inert ciphertext.
    const after = await client.get(`/customers/${customerId}`).headers(h)
    after.assertStatus(410)

    // The blind index was nulled on shred, so equality search no longer matches.
    const searchAfter = await client.post('/customers/search').headers(h).json({ cin })
    searchAfter.assertStatus(200)
    assert.lengthOf(searchAfter.body().matches, 0)
  })
})
