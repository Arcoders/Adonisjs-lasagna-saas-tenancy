import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runAce } from '../_helpers.js'

/**
 * HARDENING: `tenant:audit:export` produces correct, complete, streamed output.
 *
 * The command streams the immutable audit log to JSON or CSV. We seed a probe
 * tenant's rows with known timestamps (INSERT is the only operation the
 * append-only table allows), export to a temp file (so stdout stays clean and we
 * never parse it), and assert the round-trip: row counts, the date-window filter,
 * the CSV header, the empty case, and the invalid-date guard.
 */
test.group('hardening — tenant:audit:export', (group) => {
  const conn = () => db.connection('public')
  const probe = randomUUID()
  const files: string[] = []

  const tmpFile = (ext: string) => {
    const f = join(tmpdir(), `audit-export-${randomUUID()}.${ext}`)
    files.push(f)
    return f
  }

  group.setup(async () => {
    // Three rows at known instants: Jan, Mar, Jun 2026.
    const rows: Array<[string, string]> = [
      ['2026-01-01T00:00:00Z', 'e2e.export.jan'],
      ['2026-03-01T00:00:00Z', 'e2e.export.mar'],
      ['2026-06-01T00:00:00Z', 'e2e.export.jun'],
    ]
    for (const [ts, action] of rows) {
      await conn().rawQuery(
        `INSERT INTO backoffice.tenant_audit_logs (tenant_id, actor_type, action, created_at)
         VALUES (?, 'system', ?, ?)`,
        [probe, action, ts]
      )
    }
  })

  group.teardown(async () => {
    await Promise.all(files.map((f) => rm(f, { force: true }).catch(() => {})))
  })

  test('exports every row for a tenant as a JSON array', async ({ assert }) => {
    const out = tmpFile('json')
    const code = await runAce('tenant:audit:export', ['--tenant', probe, '--out', out])
    assert.equal(code, 0)

    const parsed = JSON.parse(await readFile(out, 'utf-8'))
    assert.isArray(parsed)
    assert.lengthOf(parsed, 3)
    for (const rec of parsed) {
      assert.equal(rec.tenantId, probe)
      assert.properties(rec, [
        'id',
        'tenantId',
        'actorType',
        'actorId',
        'action',
        'metadata',
        'ipAddress',
        'createdAt',
      ])
    }
  })

  test('--from/--to narrows to rows inside the window', async ({ assert }) => {
    const out = tmpFile('json')
    const code = await runAce('tenant:audit:export', [
      '--tenant',
      probe,
      '--from',
      '2026-02-01',
      '--to',
      '2026-04-01',
      '--out',
      out,
    ])
    assert.equal(code, 0)

    const parsed = JSON.parse(await readFile(out, 'utf-8'))
    assert.lengthOf(parsed, 1)
    assert.equal(parsed[0].action, 'e2e.export.mar')
  })

  test('--format=csv emits a header plus one line per row', async ({ assert }) => {
    const out = tmpFile('csv')
    const code = await runAce('tenant:audit:export', [
      '--tenant',
      probe,
      '--format',
      'csv',
      '--out',
      out,
    ])
    assert.equal(code, 0)

    const lines = (await readFile(out, 'utf-8')).trimEnd().split('\n')
    assert.equal(lines[0], 'id,tenantId,actorType,actorId,action,metadata,ipAddress,createdAt')
    assert.lengthOf(lines, 4) // header + 3 rows
  })

  test('an empty tenant exports an empty JSON array, exit 0', async ({ assert }) => {
    const out = tmpFile('json')
    const code = await runAce('tenant:audit:export', ['--tenant', randomUUID(), '--out', out])
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(await readFile(out, 'utf-8')), [])
  })

  test('an invalid --from fails fast with exit 1', async ({ assert }) => {
    const code = await runAce('tenant:audit:export', ['--from', 'not-a-date'])
    assert.equal(code, 1)
  })
})
