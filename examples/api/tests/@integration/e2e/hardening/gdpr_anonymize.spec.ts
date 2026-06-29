import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { createInstalledTenant, dropAllTenants, runAce } from '../_helpers.js'

/**
 * HARDENING — `tenant:gdpr:anonymize` runs the host seam and records evidence.
 *
 * The demo wires `config.compliance.anonymize` to redact every Note inside
 * tenancy.run(tenant) (examples/api/config/multitenancy.ts). We assert the full
 * contract: dry-run never writes, the real run redacts and records an immutable
 * audit entry with the reason + affected count, and a missing tenant fails.
 */
test.group('hardening — tenant:gdpr:anonymize', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  async function lastAuditFor(tenantId: string, action: string) {
    const res = await db.connection('public').rawQuery(
      `SELECT action, metadata FROM backoffice.tenant_audit_logs
         WHERE tenant_id = ? AND action = ? ORDER BY created_at DESC LIMIT 1`,
      [tenantId, action]
    )
    return res.rows[0] ?? null
  }

  test('dry-run writes nothing, records no audit entry, and exits 0', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    await client.post('/demo/notes').header('x-tenant-id', id).json({ title: 'Alice PII' })
    await client.post('/demo/notes').header('x-tenant-id', id).json({ title: 'Bob PII' })

    const code = await runAce('tenant:gdpr:anonymize', [id, '--dry-run', '--force'])
    assert.equal(code, 0)

    // Notes are untouched by a dry run.
    const after = await client.get('/demo/notes').header('x-tenant-id', id)
    const titles = after
      .body()
      .notes.map((n: any) => n.title)
      .sort()
    assert.deepEqual(titles, ['Alice PII', 'Bob PII'])

    // A preview must NOT pollute the append-only audit log.
    const entry = await lastAuditFor(id, 'gdpr.anonymize')
    assert.isNull(entry, 'a dry run must not record an immutable audit entry')
  })

  test('a real run redacts PII and records an immutable audit entry', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    await client.post('/demo/notes').header('x-tenant-id', id).json({ title: 'Carol PII' })

    const code = await runAce('tenant:gdpr:anonymize', [id, '--force', '--reason', 'DSAR-e2e'])
    assert.equal(code, 0)

    const after = await client.get('/demo/notes').header('x-tenant-id', id)
    for (const note of after.body().notes) {
      assert.equal(note.title, 'Redacted')
      assert.isNull(note.body)
    }

    const entry = await lastAuditFor(id, 'gdpr.anonymize')
    assert.exists(entry, 'a gdpr.anonymize audit entry must be recorded')
    assert.equal(entry.metadata.reason, 'DSAR-e2e')
    assert.equal(entry.metadata.outcome, 'ok')
    assert.equal(entry.metadata.affected, 1)
  })

  test('a missing tenant fails with exit 1', async ({ assert }) => {
    const code = await runAce('tenant:gdpr:anonymize', [randomUUID(), '--force'])
    assert.equal(code, 1)
  })
})
