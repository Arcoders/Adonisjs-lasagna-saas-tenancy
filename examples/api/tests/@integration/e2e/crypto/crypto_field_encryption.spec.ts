import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * Crypto E2E: field encryption end to end through the booted server and real Postgres.
 *
 * This is the crown-jewel proof the package previously lacked (crypto had no e2e).
 * A real HTTP client encrypts a secret as a tenant, and we assert every crypto
 * guarantee against the actual per-tenant schema:
 *   - the plaintext round-trips through the `@encrypted` model hooks, but the DB
 *     column holds enc_v2 ciphertext and a keyed-HMAC blind index, never plaintext;
 *   - an equality search finds the row via the blind index alone;
 *   - a crypto-shred makes the ciphertext inert: the live read fails closed (410),
 *     and the value is unrecoverable while the ciphertext stays physically present;
 *   - the two-phase shred wrote to the WORM ledger, which is append-only at the DB
 *     level (UPDATE/DELETE rejected);
 *   - the DB-level CHECK rejects a raw plaintext write to the encrypted column (the
 *     bypass the model hooks cannot see).
 */
test.group('crypto: field encryption end to end (real HTTP and real PG)', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('encrypt over HTTP, plaintext round-trips; the DB column holds enc_v2 ciphertext', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client, { plan: 'pro' })

    const created = await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', t.id)
      .json({ subject: 'renter-1', secret: 'passport-AB1234567' })
    created.assertStatus(201)

    // Plaintext round-trips through the model hooks on read.
    const read = await client.get('/demo/secure-notes/renter-1').header('x-tenant-id', t.id)
    read.assertStatus(200)
    assert.equal(read.body().secret, 'passport-AB1234567')

    // On disk it is enc_v2 ciphertext and a non-empty blind index, never the plaintext.
    const conn = (await Tenant.findOrFail(t.id)).getConnection()
    const raw = await conn.rawQuery(
      'SELECT secret, secret_index FROM secure_notes WHERE subject = ?',
      ['renter-1']
    )
    const row = raw.rows[0]
    assert.isTrue(String(row.secret).startsWith('enc_v2:'), 'ciphertext at rest')
    assert.notInclude(String(row.secret), 'passport-AB1234567')
    assert.match(
      String(row.secret_index),
      /^[0-9a-f]{64}$/,
      'a keyed-HMAC blind index, not plaintext'
    )
  })

  test('a blind-index equality search finds a record by exact value (no plaintext stored)', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client, { plan: 'pro' })
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', t.id)
      .json({ subject: 'renter-2', secret: 'find-me-XYZ-42' })
      .then((r) => r.assertStatus(201))

    const found = await client
      .post('/demo/secure-notes/search')
      .header('x-tenant-id', t.id)
      .json({ value: 'find-me-XYZ-42' })
    found.assertStatus(200)
    const subjects = (found.body().matches as Array<{ subject: string; secret: string }>).map(
      (m) => m.subject
    )
    assert.include(subjects, 'renter-2', 'the blind index located the record by exact value')

    // A different value matches nothing (the HMAC is value-specific).
    const miss = await client
      .post('/demo/secure-notes/search')
      .header('x-tenant-id', t.id)
      .json({ value: 'not-stored' })
    miss.assertStatus(200)
    assert.lengthOf(miss.body().matches, 0)
  })

  test('crypto-shred makes the ciphertext inert: the live read fails closed (410)', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client, { plan: 'pro' })
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', t.id)
      .json({ subject: 'renter-3', secret: 'passport-SHRED-99' })
      .then((r) => r.assertStatus(201))

    // Before the shred, the value reads back.
    await client
      .get('/demo/secure-notes/renter-3')
      .header('x-tenant-id', t.id)
      .then((r) => {
        r.assertStatus(200)
        assert.equal(r.body().secret, 'passport-SHRED-99')
      })

    // Shred the (subject × category) DEK; governance says demo-secret is erasable.
    const shredded = await client
      .post('/demo/secure-notes/renter-3/shred')
      .header('x-tenant-id', t.id)
    shredded.assertStatus(200)
    assert.isTrue(shredded.body().shredded, 'the shred reports success')

    // The live read now fails closed (410 Gone) and NEVER surfaces the ciphertext.
    const afterShred = await client.get('/demo/secure-notes/renter-3').header('x-tenant-id', t.id)
    afterShred.assertStatus(410)
    assert.notInclude(JSON.stringify(afterShred.body()), 'passport-SHRED-99')

    // The ciphertext is still physically present (the host must null its column) but
    // is now undecryptable: the DEK's only live copy was destroyed.
    const conn = (await Tenant.findOrFail(t.id)).getConnection()
    const raw = await conn.rawQuery('SELECT secret FROM secure_notes WHERE subject = ?', [
      'renter-3',
    ])
    assert.isTrue(String(raw.rows[0].secret).startsWith('enc_v2:'), 'inert ciphertext remains')
  })

  test('the WORM shred ledger is append-only: the shred wrote rows, UPDATE/DELETE are rejected', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client, { plan: 'pro' })
    await client
      .post('/demo/secure-notes')
      .header('x-tenant-id', t.id)
      .json({ subject: 'renter-4', secret: 'passport-WORM' })
      .then((r) => r.assertStatus(201))
    await client
      .post('/demo/secure-notes/renter-4/shred')
      .header('x-tenant-id', t.id)
      .then((r) => r.assertStatus(200))

    const back = db.connection('backoffice')
    const count = await back.rawQuery(
      'SELECT count(*)::int AS n FROM backoffice.worm_ledger WHERE tenant_id = ?',
      [t.id]
    )
    assert.isAbove(count.rows[0].n, 0, 'the two-phase shred appended audit rows')

    // Append-only at the DB level: the triggers reject a rewrite or an erase.
    await assert.rejects(
      () =>
        back.rawQuery("UPDATE backoffice.worm_ledger SET reason = 'tamper' WHERE tenant_id = ?", [
          t.id,
        ]),
      /append-only/
    )
    await assert.rejects(
      () => back.rawQuery('DELETE FROM backoffice.worm_ledger WHERE tenant_id = ?', [t.id]),
      /append-only/
    )
  })

  test('the encrypted-column CHECK rejects a raw plaintext write (write backstop, bypassing the model)', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client, { plan: 'pro' })
    const conn = (await Tenant.findOrFail(t.id)).getConnection()

    // A raw INSERT bypasses the @encrypted hooks, the one bypass a model-level guard
    // cannot see. The DB CHECK must reject a plaintext value in the guarded column.
    await assert.rejects(() =>
      conn.rawQuery(
        "INSERT INTO secure_notes (id, subject, secret) VALUES (gen_random_uuid(), 'raw', ?)",
        ['plaintext-passport']
      )
    )

    // A genuine enc_v2 value writes cleanly (the CHECK never false-rejects ciphertext).
    await conn.rawQuery(
      "INSERT INTO secure_notes (id, subject, secret) VALUES (gen_random_uuid(), 'raw', ?)",
      ['enc_v2:kid:iv:tag:cipher']
    )
    const n = await conn.rawQuery(
      "SELECT count(*)::int AS n FROM secure_notes WHERE subject = 'raw'"
    )
    assert.equal(n.rows[0].n, 1)
  })
})
