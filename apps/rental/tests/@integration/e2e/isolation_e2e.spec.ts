import { test } from '@japa/runner'
import { realms, authHeaders } from './_helpers.js'

/**
 * Tenant isolation + the membership firewall, end to end over HTTP. Every
 * company gets its own `tenant_<uuid>` schema, so two companies must see
 * disjoint fleets, an anonymous caller must be refused (deny-by-default), and a
 * token minted in one company must be worthless against another's schema.
 */
test.group('isolation — tenant fleet + membership firewall', () => {
  test('each company sees only its own fleet', async ({ client, assert }) => {
    const { acme, sahara } = await realms(client)

    const acmeRes = await client.get('/vehicles').headers(authHeaders(acme))
    acmeRes.assertStatus(200)
    const acmePlates: string[] = acmeRes.body().vehicles.map((v: { plate: string }) => v.plate)

    const saharaRes = await client.get('/vehicles').headers(authHeaders(sahara))
    saharaRes.assertStatus(200)
    const saharaPlates: string[] = saharaRes.body().vehicles.map((v: { plate: string }) => v.plate)

    assert.isAtLeast(acmePlates.length, 12)
    assert.isAtLeast(saharaPlates.length, 6)
    // Physically-isolated schemas: no plate is visible to both companies.
    const overlap = acmePlates.filter((p) => saharaPlates.includes(p))
    assert.lengthOf(overlap, 0)
  })

  test('an anonymous caller is denied on a tenant route (deny-by-default)', async ({ client }) => {
    const { acme } = await realms(client)
    // A resolvable company, but no credential: the membership gate refuses.
    const res = await client.get('/vehicles').header('x-tenant-id', acme.id)
    res.assertStatus(403)
  })

  test("another company's token is refused (cross-tenant IDOR)", async ({ client }) => {
    const { acme, sahara } = await realms(client)
    // Acme's token presented against Sahara's schema. The token guard looks the
    // token up inside the RESOLVED company's own `auth_access_tokens`, where this
    // row does not exist, so membership fails — no prefix inspection needed.
    const res = await client
      .get('/vehicles')
      .header('x-tenant-id', sahara.id)
      .header('authorization', `Bearer ${acme.token}`)
    res.assertStatus(403)
  })
})
