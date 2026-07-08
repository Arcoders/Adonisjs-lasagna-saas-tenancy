import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import {
  provisionVectorExtension,
  provisionExtension,
  pgvectorExtensionCheck,
  PGVECTOR_EXTENSION_SCHEMA,
} from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * Real-Postgres proof of pgvector provisioning (SEAM-5) on the schema-pg fixture
 * (one shared database, the "central" path). Self-skips when the running
 * PostgreSQL image does not ship pgvector (the extension is not in
 * pg_available_extensions), mirroring the real-API-smoke convention, so the CI
 * pgvector image runs it while a plain postgres image does not fail.
 */
const central = () => db.connection(getConfig().centralConnectionName)

async function vectorAvailable(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)
  return (r.rows ?? []).length > 0
}
async function vectorInstalled(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
  return (r.rows ?? []).length > 0
}
async function vectorInExpectedSchema(): Promise<boolean> {
  const r = await central().rawQuery(
    `SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'vector' AND n.nspname = ?`,
    [PGVECTOR_EXTENSION_SCHEMA]
  )
  return (r.rows ?? []).length > 0
}
const doctorCtx = () => ({ tenants: [], repo: {} as never, attemptFix: false })

test.group('pgvector provisioning (integration, real Postgres)', (group) => {
  group.each.setup(async () => {
    if (await vectorAvailable()) {
      await central().rawQuery('DROP EXTENSION IF EXISTS vector')
    }
  })
  group.each.teardown(async () => {
    if (await vectorAvailable()) {
      await central().rawQuery('DROP EXTENSION IF EXISTS vector')
    }
  })

  test('provisions the extension on the shared database; dry run does not', async ({ assert }) => {
    if (!(await vectorAvailable())) return // self-skip: image without pgvector

    assert.isFalse(await vectorInstalled(), 'clean slate: extension absent')

    const dry = await provisionVectorExtension({ dryRun: true })
    assert.isTrue(dry.dryRun)
    assert.isFalse(await vectorInstalled(), 'dry run installed nothing')

    const summary = await provisionVectorExtension()
    assert.equal(summary.scope, 'central')
    assert.isTrue(await vectorInstalled(), 'extension installed on the shared database')
    assert.isTrue(
      await vectorInExpectedSchema(),
      `extension installed INTO the "${PGVECTOR_EXTENSION_SCHEMA}" schema so a bare vector(N) column resolves from the tenant search_path`
    )

    // idempotent: a second run does not error
    await provisionVectorExtension()
    assert.isTrue(await vectorInstalled())
  })

  test('the doctor check flags a missing extension and clears once provisioned', async ({
    assert,
  }) => {
    if (!(await vectorAvailable())) return

    const before = await pgvectorExtensionCheck.run(doctorCtx())
    assert.isTrue(
      before.some((i) => i.code === 'vector_extension_missing'),
      'reports the extension missing before provisioning'
    )

    await provisionVectorExtension()

    const after = await pgvectorExtensionCheck.run(doctorCtx())
    assert.isFalse(
      after.some((i) => i.code === 'vector_extension_missing'),
      'no missing-extension issue once provisioned'
    )
  })
})

/**
 * SEAM-7 integration: the GENERIC engine `provisionExtension` (which
 * `provisionVectorExtension` now delegates to) installs an arbitrary extension
 * against real Postgres. Uses `pg_trgm` (a common contrib extension) with NO
 * dedicated schema, so it also exercises the schema-less `CREATE EXTENSION` path.
 * Self-skips when the image does not ship pg_trgm, mirroring the vector convention.
 */
async function trgmAvailable(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm'`)
  return (r.rows ?? []).length > 0
}
async function trgmInstalled(): Promise<boolean> {
  const r = await central().rawQuery(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
  return (r.rows ?? []).length > 0
}

test.group('generic provisionExtension (integration, real Postgres)', (group) => {
  group.each.setup(async () => {
    if (await trgmAvailable()) await central().rawQuery('DROP EXTENSION IF EXISTS pg_trgm')
  })
  group.each.teardown(async () => {
    if (await trgmAvailable()) await central().rawQuery('DROP EXTENSION IF EXISTS pg_trgm')
  })

  test('provisions a schema-less extension on the shared database; dry run does not', async ({
    assert,
  }) => {
    if (!(await trgmAvailable())) return // self-skip: image without pg_trgm

    assert.isFalse(await trgmInstalled(), 'clean slate')

    const dry = await provisionExtension({ name: 'pg_trgm' }, { dryRun: true })
    assert.equal(dry.extension, 'pg_trgm')
    assert.isTrue(dry.dryRun)
    assert.isFalse(await trgmInstalled(), 'dry run installed nothing')

    const summary = await provisionExtension({ name: 'pg_trgm' })
    assert.equal(summary.extension, 'pg_trgm')
    assert.equal(summary.scope, 'central')
    assert.isTrue(await trgmInstalled(), 'extension installed on the shared database')

    // idempotent: a second run does not error
    await provisionExtension({ name: 'pg_trgm' })
    assert.isTrue(await trgmInstalled())
  })
})
